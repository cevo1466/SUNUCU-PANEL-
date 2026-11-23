#!/usr/bin/env bash
# ops/scripts/pause-vhost.sh <domain> <pause|resume>
#
# Siteyi SILMEDEN yayindan alir / geri getirir.
#
# pause : /etc/nginx/conf.d/<domain>.conf -> <domain>.conf.paused olarak saklanir
#         (nginx yalnizca *.conf okur, bu yuzden dosya devre disi kalir) ve yerine
#         "yayin durduruldu" (503) sayfasi donen kucuk bir vhost yazilir.
#         Dosyalar, veritabani, posta, DNS ve sertifikalar OLDUGU GIBI kalir.
# resume: saklanan orijinal conf aynen geri konur. Orijinal geri konuldugu icin
#         HTTPS ve ucretli (custom) sertifika ayari da kaybolmaz.
#
# Durum DB'de DEGIL dosyada tutulur: panelin "yayinda mi" bilgisi nginx'in
# gercekten okudugu dizinden gelir (bkz. apps/api/src/lib/domain.ts
# isPublishPaused). Gercek nginx `proxy-server` container'inda calisir
# (bkz. deploy-vhost.sh), bu yuzden dogrulama/reload orada yapilir.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 2 ] || fail "Kullanim: $0 <domain> <pause|resume>"
DOMAIN="$1"
ACTION="$2"

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Gecersiz domain adi: $DOMAIN"

CONF="/etc/nginx/conf.d/${DOMAIN}.conf"
SAVED="${CONF}.paused"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAUSED_PAGE_SRC="$(cd "$SCRIPT_DIR/../.." && pwd)/ops/nginx/paused.html"
# nginx yalnizca *.conf okur; .html dosyasi conf.d'de zararsiz ve proxy-server ile paylasimli.
PAUSED_PAGE_DEST="/etc/nginx/conf.d/_yayin-durduruldu.html"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

reload_nginx() {
  docker exec proxy-server nginx -t >/dev/null 2>"$WORK/nginx-t.log" || { cat "$WORK/nginx-t.log" >&2; return 1; }
  docker exec proxy-server nginx -s reload
}

write_stub() {
  local names cert key
  # Orijinaldeki TUM server_name'ler (www, alt alan adlari...). Yorum satirlari atlanir.
  names="$(grep -hE '^[[:space:]]*server_name[[:space:]]' "$SAVED" \
    | sed -E 's/^[[:space:]]*server_name[[:space:]]+//; s/;.*$//' | tr -s ' \t' '\n' \
    | { grep -E '^[A-Za-z0-9.-]+$' || true; } | sort -u | tr '\n' ' ')"
  [ -n "$names" ] || names="$DOMAIN www.$DOMAIN"

  {
    cat <<EOF
# pause-vhost.sh tarafindan uretildi. Orijinal yapilandirma: ${SAVED}
server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/vhosts/_acme;
        try_files \$uri =404;
    }
    error_page 503 /_yayin-durduruldu.html;
    location = /_yayin-durduruldu.html {
        internal;
        root /etc/nginx/conf.d;
        add_header Retry-After 3600 always;
        add_header Cache-Control "no-store" always;
        add_header X-Robots-Tag "noindex" always;
    }
    location / {
        return 503;
    }
}
EOF
    # Orijinalde HTTPS varsa ayni sertifika ile 443'te de 503 don; aksi halde
    # tarayici sertifika hatasi gorur ve "durduruldu" mesaji hic okunamaz.
    cert="$(grep -hE '^[[:space:]]*ssl_certificate[[:space:]]' "$SAVED" | head -1 | sed -E 's/^[[:space:]]*ssl_certificate[[:space:]]+//; s/;.*$//' || true)"
    key="$(grep -hE '^[[:space:]]*ssl_certificate_key[[:space:]]' "$SAVED" | head -1 | sed -E 's/^[[:space:]]*ssl_certificate_key[[:space:]]+//; s/;.*$//' || true)"
    if grep -qE '^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl' "$SAVED" && [ -n "$cert" ] && [ -n "$key" ]; then
      cat <<EOF

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${names};

    ssl_certificate     ${cert};
    ssl_certificate_key ${key};

    error_page 503 /_yayin-durduruldu.html;
    location = /_yayin-durduruldu.html {
        internal;
        root /etc/nginx/conf.d;
        add_header Retry-After 3600 always;
        add_header Cache-Control "no-store" always;
        add_header X-Robots-Tag "noindex" always;
    }
    location / {
        return 503;
    }
}
EOF
    fi
  } > "$WORK/stub.conf"
}

case "$ACTION" in
  pause)
    [ ! -e "$SAVED" ] || fail "$DOMAIN zaten durdurulmus."
    [ -f "$CONF" ] || fail "$DOMAIN su an Nginx'te yayinda degil, durdurulacak bir sey yok."
    [ -f "$PAUSED_PAGE_SRC" ] || fail "Durdurma sayfasi bulunamadi: $PAUSED_PAGE_SRC"
    cp -p "$CONF" "$SAVED"
    install -m 0644 "$PAUSED_PAGE_SRC" "$PAUSED_PAGE_DEST"
    write_stub
    cp "$WORK/stub.conf" "$CONF"
    chmod 0644 "$CONF"
    if ! reload_nginx; then
      echo "✗ nginx -t BASARISIZ — orijinal yapilandirma geri yukleniyor." >&2
      mv -f "$SAVED" "$CONF"
      exit 1
    fi
    echo "✓ $DOMAIN yayindan alindi (503). Devam ettirmek icin: $0 $DOMAIN resume"
    ;;
  resume)
    [ -f "$SAVED" ] || fail "$DOMAIN durdurulmus degil."
    cp -p "$CONF" "$WORK/stub.bak" 2>/dev/null || true
    mv -f "$SAVED" "$CONF"
    if ! reload_nginx; then
      echo "✗ nginx -t BASARISIZ — durdurulmus hale geri donuluyor." >&2
      cp -p "$CONF" "$SAVED"
      [ -f "$WORK/stub.bak" ] && cp -p "$WORK/stub.bak" "$CONF"
      exit 1
    fi
    echo "✓ $DOMAIN yeniden yayinda."
    ;;
  *) fail "Eylem 'pause' veya 'resume' olmali." ;;
esac
