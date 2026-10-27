#!/usr/bin/env bash
# ops/scripts/panel-ssl.sh <hostname>
#
# PANELIN KENDISI icin Let's Encrypt sertifikasi alir ve HTTPS server blogunu
# yazar.
#
# NEDEN AYRI SCRIPT: ssl-issue.sh bir MUSTERI DOMAINININ vhost'unu hedefliyor
# ve /var/www/vhosts/<domain>/public dizinini bekliyor. Panel bir vhost degil,
# 3000 portundaki Next.js uygulamasi; kendi dizini yok.
#
# NEDEN ONEMLI: panel bu degisiklige kadar YALNIZCA 80 portundaydi. Yonetici
# oturum cerezi ve butun panel trafigi sifresiz tasiniyordu — aradaki herhangi
# biri cerezi okuyup panele girebilirdi. Domainlere HSTS eklerken panelin
# kendisinin duz HTTP'de kaldigi fark edildi (2026-09-03).
#
# IP UZERINDEN ERISIM BOZULMAZ: mevcut `default_server` blogu oldugu gibi
# kalir. Sertifika yalnizca verilen hostname icin ayri bir blokta devreye
# girer; kullanici kendini disarida birakmaz.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanim: $0 <hostname>   (ornek: $0 panel.ornek.test)"
HOST="$1"

[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Gecersiz hostname: $HOST"
[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $HOST' ile calistirin."

WEBROOT="/var/www/vhosts/_acme"
CONF="/etc/nginx/conf.d/studio-panel-ssl.conf"
LIVE="/etc/letsencrypt/live/$HOST"
UPSTREAM="${NGINX_UPSTREAM_HOST:-172.19.0.1}:3000"
# API dogrudan buraya proxy'lenir (Next.js rewrite'ini ATLAR) — bkz. asagidaki
# "location /api/" yorumu, 2026-09-04 socket-hang-up kusuru.
API_UPSTREAM="${NGINX_UPSTREAM_HOST:-172.19.0.1}:3001"

command -v certbot >/dev/null 2>&1 || fail "certbot kurulu degil (apk add certbot)."
command -v docker >/dev/null 2>&1 || fail "docker bulunamadi (nginx proxy-server konteynerinde)."

# Adin GERCEKTEN var olup olmadigi — otoriter sunucudan.
# `getent` tek basina yetmez: yerel cozumleyici negatif cevaplari SOA
# minimum'u kadar onbellekte tutuyor (bkz. ssl-issue.sh resolves_host).
resolves_host() {
  _rh_host="$1"
  if command -v dig >/dev/null 2>&1; then
    _rh_ns="$(dig +noall +authority +answer "$_rh_host" SOA 2>/dev/null | awk '$4=="SOA"{print $5; exit}')"
    if [ -n "$_rh_ns" ] && [ -n "$(dig +short "@$_rh_ns" "$_rh_host" A 2>/dev/null | head -1)" ]; then
      return 0
    fi
  fi
  getent ahostsv4 "$_rh_host" >/dev/null 2>&1
}
resolves_host "$HOST" || fail "$HOST cozumlenmiyor. Once A kaydini olusturun."
echo "» $HOST cozumleniyor"

mkdir -p "$WEBROOT/.well-known/acme-challenge"
ACME_OWNER="$(stat -c '%u:%g' "$WEBROOT" 2>/dev/null || true)"

TMP_OLD=""
if [ -f "$CONF" ]; then TMP_OLD="$(mktemp)"; cp "$CONF" "$TMP_OLD"; fi

restore_conf() {
  if [ -n "$TMP_OLD" ]; then cp "$TMP_OLD" "$CONF"; else rm -f "$CONF"; fi
  docker exec proxy-server nginx -t >/dev/null 2>&1 && docker exec proxy-server nginx -s reload >/dev/null 2>&1
}

# --- ONCE ACME BLOGU, SONRA CERTBOT ---
#
# Yumurta-tavuk: sertifika yokken $HOST icin ayri bir server blogu da yok, bu
# yuzden istek `default_server`a (panelin kendisine) dusuyor ve panel
# /.well-known/acme-challenge/... yolunu Next.js'e proxy'liyor; middleware onu
# /login'e yonlendiriyor. Let's Encrypt dosya yerine giris sayfasini
# indiriyor ve dogrulama "unauthorized" ile basarisiz oluyor — ilk denemede
# tam olarak bu oldu.
#
# Cozum: dogrulama yolunu certbot CALISMADAN ONCE acmak.
echo "» ACME dogrulama yolu aciliyor"
cat > "$CONF" <<EOF
# Studio Panel — gecici ACME blogu (panel-ssl.sh calisiyor).
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { proxy_pass http://$UPSTREAM; proxy_set_header Host \$host; }
}
EOF
if ! docker exec proxy-server nginx -t >/dev/null 2>&1; then
  restore_conf
  docker exec proxy-server nginx -t 2>&1 | tail -3
  fail "ACME blogu nginx tarafindan kabul edilmedi; degisiklik geri alindi."
fi
docker exec proxy-server nginx -s reload

echo "» Let's Encrypt sertifikasi isteniyor: $HOST"
certbot certonly --webroot -w "$WEBROOT" -d "$HOST" \
  --cert-name "$HOST" --non-interactive --agree-tos \
  --register-unsafely-without-email --keep-until-expiring \
  || { restore_conf; fail "certbot basarisiz. $HOST'un 80 portundan disaridan erisilebildigini dogrulayin."; }

# root'un dokundugu dizini panele geri ver (bkz. ssl-issue.sh restore_owner).
[ -n "$ACME_OWNER" ] && chown -R "$ACME_OWNER" "$WEBROOT" 2>/dev/null || true

[ -f "$LIVE/fullchain.pem" ] || fail "Sertifika dosyasi yok: $LIVE/fullchain.pem"

# /etc/letsencrypt proxy-server ile PAYLASILMIYOR; kopyalanmazsa nginx
# sertifikayi goremez ve `nginx -t` "BIO_new_file() failed" ile duser.
echo "» Sertifika proxy-server konteynerine kopyalaniyor"
docker exec proxy-server mkdir -p "$LIVE"
docker cp -L "$LIVE/fullchain.pem" "proxy-server:$LIVE/fullchain.pem"
docker cp -L "$LIVE/privkey.pem" "proxy-server:$LIVE/privkey.pem"

cat > "$CONF" <<EOF
# Studio Panel — HTTPS. ops/scripts/panel-ssl.sh tarafindan uretildi, ELLE
# DUZENLEME.
#
# Mevcut studio-panel.conf (80, default_server) DOKUNULMADAN kalir: IP
# uzerinden erisim calismaya devam eder, yonetici kendini disarida birakmaz.

server {
    listen 80;
    listen [::]:80;
    server_name $HOST;

    # ACME yonlendirmeden ONCE. "^~" oneki "location /" ifadesine gore
    # onceliklidir; dogrulama istegi 301 yerse sertifika yenilemesi 90 gun
    # sonra sessizce durur.
    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
    }

    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $HOST;

    ssl_certificate     $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;

    # HSTS YALNIZCA burada (443). "always" sart: onsuz nginx basligi 404 ve
    # 500 yanitlarina eklemez. includeSubDomains/preload YOK, gerekcesi
    # apps/api/src/lib/nginxTemplate.ts HSTS_VALUE aciklamasinda.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    # Panel bir yonetim arayuzu: cerceveye alinmasi (clickjacking) dogrudan
    # sunucu ele gecirme anlamina gelebilir.
    add_header X-Frame-Options           "DENY" always;
    add_header Permissions-Policy        "camera=(), microphone=(), geolocation=()" always;

    # Yukleme sinirlari studio-panel.conf ile AYNI olmali; zincirin en dar
    # halkasi kazanir ve biri geride kalirsa kullanici sebebi gorunmeyen bir
    # 413 alir.
    client_max_body_size 2048m;

    # API DOGRUDAN BURADAN, Next.js REWRITE'INI ATLAYARAK, Fastify'a gider.
    #
    # NEDEN (gercek kusur, 2026-09-04): /api/* eskiden next.config.ts
    # rewrites() ile Next.js'e dusuyor, Next de kendi ic proxy'siyle
    # 127.0.0.1:3001'e iletiyordu. Next'in bu ic proxy'sinin, yedekleme gibi
    # 45-50 saniye suren istekleri kesip "socket hang up"/ECONNRESET ile
    # dusurdugu gorulduu (ops/web.log). Istemci bunu bos govdeli bir 500
    # olarak goruyordu — OYSA Fastify istegi arka planda TAMAMLIYORDU
    # (backup_runs'ta 'ok' olarak kayitli, sadece yanit istemciye ulasamiyordu).
    # nginx zaten 3600s zaman asimiyla uzun istekleri sorunsuz tasiyor; API'yi
    # ondan gecirmek bu sinifin tamamini ortadan kaldirir. `location /api/`
    # `location /` icinde degil, ONCE geldigi icin oncelikli eslesir.
    location /api/ {
        proxy_pass http://$API_UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";

        # Buyuk yuklemeler: buffering acikken nginx istegin TAMAMINI once
        # kendi diskine yazar, ilerleme cubugu yalan soyler ve zaman asimi
        # yukleme ortasinda 504 verir. Bkz. studio-panel.conf.
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

if ! docker exec proxy-server nginx -t >/dev/null 2>&1; then
  restore_conf
  [ -n "$TMP_OLD" ] && rm -f "$TMP_OLD"
  docker exec proxy-server nginx -t 2>&1 | tail -3
  fail "nginx dogrulamasi basarisiz; eski yapilandirmaya donuldu, reload YAPILMADI."
fi
[ -n "$TMP_OLD" ] && rm -f "$TMP_OLD"

docker exec proxy-server nginx -s reload
echo "✓ Panel artik https://$HOST uzerinden yayinda (IP uzerinden HTTP erisimi de duruyor)."
