#!/usr/bin/env bash
# Prod-only günlük yenileme işi. DATABASE_URL, psql, certbot ve docker (proxy-server
# container'ında nginx reload için) gerekir.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir."
# psql BILINCLI OLARAK ARANMIYOR — bu sunucuda yok. Panelin PostgreSQL'i
# packages/db/.pg-runtime altinda gomulu calisiyor ve o paket yalnizca sunucu
# ikililerini iceriyor. Sorgular ops/scripts/db-query.mjs (node + pg) ile
# yapiliyor; o yardimci DATABASE_URL'i .env.loopkit'ten kendisi okur, bu
# yuzden cron ortaminda da calisir.
DB_QUERY="$(cd "$(dirname "$0")" && pwd)/db-query.mjs"
[ -x "$DB_QUERY" ] || fail "db-query.mjs bulunamadı: $DB_QUERY"
command -v node >/dev/null 2>&1 || fail "node bulunamadı"
command -v certbot >/dev/null 2>&1 || fail "certbot bulunamadı"
command -v docker >/dev/null 2>&1 || fail "docker bulunamadı (nginx proxy-server container'ında çalışıyor)"

STATE_DIR="${STUDIO_PANEL_SSL_STATE_DIR:-/var/lib/studio-panel/ssl-renew}"
ALARM_LOG="${STUDIO_PANEL_SSL_ALARM_LOG:-/var/log/studio-panel-ssl-alerts.log}"
mkdir -p "$STATE_DIR"

# SUNUCUDAKI TUM SERTIFIKALAR — veritabanindakiler DEGIL.
#
# GERCEK ARIZA (2026-09-03): liste `domains` tablosundan geliyordu, yani
# yalnizca musteri alan adlari yenileniyordu. Sunucuda 6 sertifika vardi ve
# 2'si yenileniyordu: `webmail.musteri.test`, `webmail.ornek.test`,
# `webmail.testsite.ornek.test` ve `test.diger.test` HICBIR zaman
# yenilenmeyecekti — 87 gun sonra sessizce olurlerdi ve bunu ancak webmail
# HTTPS vermeyi birakinca ogrenirdik. Panelin kendi sertifikasi da
# (panel-ssl.sh) ayni gruba katilacakti.
#
# Kaynak artik CERTBOT'UN KENDISI: hangi sertifikalar gercekten var, o
# biliyor. Veritabani bir alt kume; "yenilenecekler" listesini oradan
# tureterek sunucudaki gercekligi gormezden geliyorduk.
DOMAINS="$(certbot certificates 2>/dev/null | awk '/Certificate Name:/{print $3}')" \
  || fail "Sertifika listesi certbot'tan okunamadı"

[ -n "$DOMAINS" ] || { echo "✓ Sunucuda Let's Encrypt sertifikası yok."; exit 0; }

FAILED=0
while IFS= read -r DOMAIN; do
  [ -n "$DOMAIN" ] || continue
  if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; then
    echo "✗ Veritabanındaki geçersiz domain atlandı: $DOMAIN" >&2
    FAILED=1
    continue
  fi
  STATE_FILE="$STATE_DIR/$DOMAIN.failures"
  # Gerçek nginx bu container'da değil, ayrı proxy-server container'ında
  # çalışıyor (bkz. ssl-issue.sh / deploy-vhost.sh, 2026-08-28 düzeltmesi) —
  # deploy-hook da AYNI şekilde docker exec kullanmalı, yoksa yenilenen
  # sertifika hiçbir zaman gerçek nginx'e ulaşmaz. AYRICA /etc/letsencrypt/
  # proxy-server ile PAYLAŞILMIYOR (yalnızca /var/www/vhosts ve
  # /etc/nginx/conf.d bind-mount) — bu yüzden hook, certbot'un hook'a verdiği
  # $RENEWED_LINEAGE (yenilenen sertifikanın live/ dizini) içindeki
  # fullchain.pem/privkey.pem'i -L (sembolik link çözerek) proxy-server'a
  # `docker cp` ile senkronize etmeli (bkz. ssl-issue.sh, aynı desen).
  # \$RENEWED_LINEAGE burada BİLEREK kaçırılıyor — certbot'un çalıştırdığı
  # hook alt kabuğunda genişlemeli, bu script'in kendi kabuğunda DEĞİL.
  if certbot renew --cert-name "$DOMAIN" --non-interactive --deploy-hook \
    "docker exec proxy-server mkdir -p \"\$RENEWED_LINEAGE\" && docker cp -L \"\$RENEWED_LINEAGE/fullchain.pem\" \"proxy-server:\$RENEWED_LINEAGE/fullchain.pem\" && docker cp -L \"\$RENEWED_LINEAGE/privkey.pem\" \"proxy-server:\$RENEWED_LINEAGE/privkey.pem\" && docker exec proxy-server nginx -t && docker exec proxy-server nginx -s reload"; then
    EXPIRY="$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" | cut -d= -f2)"
    # DB guncellemesi yalnizca panel domainleri icin anlamli: webmail.* ve
    # panel.* sertifikalarinin `domains` tablosunda karsiligi yok ve UPDATE
    # sessizce 0 satir etkiler (hata degil).
    node "$DB_QUERY" \
      "UPDATE domains SET ssl_status=TRUE, ssl_expiry=\$1::timestamptz WHERE domain_name=\$2 AND ssl_type <> 'custom'" \
      "$EXPIRY" "$DOMAIN" >/dev/null
    rm -f "$STATE_FILE"
    echo "✓ $DOMAIN yenilendi; yeni bitiş: $EXPIRY"
  else
    COUNT=0
    [ -f "$STATE_FILE" ] && COUNT="$(cat "$STATE_FILE")"
    COUNT=$((COUNT + 1))
    printf '%s\n' "$COUNT" > "$STATE_FILE"
    echo "✗ $DOMAIN yenilenemedi (ardışık deneme: $COUNT)" >&2
    if [ "$COUNT" -ge 3 ]; then
      printf '%s ALARM domain=%s consecutive_failures=%s\n' "$(date -u +%FT%TZ)" "$DOMAIN" "$COUNT" >> "$ALARM_LOG"
      # Log dosyasi tek basina YETMEZ — onu kimse okumuyordu. Panelin zaten
      # calisan Telegram yoluna da bildir. Telegram yapilandirilmamissa
      # notify.mjs sessizce cikar, bu yuzden `|| true` gerekmez ama yenileme
      # dongusunu bildirim hatasi kesmesin diye yine de yutuluyor.
      node "$(dirname "$0")/notify.mjs" \
        "SSL yenilenemedi: $DOMAIN" \
        "$COUNT ardisik denemede basarisiz. Sertifika suresi dolarsa site HTTPS vermeyi birakir.
Kontrol: sudo $(dirname "$0")/ssl-renew.sh
Log: $ALARM_LOG" \
        critical || true
    fi
    FAILED=1
  fi
done <<EOF
$DOMAINS
EOF

# --- SON KONTROL: yenileme turu GERCEKTEN ise yaradi mi ---
#
# `certbot renew` "not yet due" deyip 0 ile cikar; bu normaldir. Ama bir
# sertifika bu turdan SONRA hala 20 gunden az omurluyse yenileme calismiyor
# demektir ve bunu 20 gun boyunca fark etmeyebiliriz. Kayda degil SONUCA
# bakiyoruz.
NOW="$(date -u +%s)"
while IFS= read -r DOMAIN; do
  [ -n "$DOMAIN" ] || continue
  PEM="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  [ -f "$PEM" ] || continue
  END="$(openssl x509 -enddate -noout -dateopt iso_8601 -in "$PEM" 2>/dev/null | cut -d= -f2)"
  [ -n "$END" ] || continue
  END_TS="$(date -u -D '%Y-%m-%d %H:%M:%SZ' -d "$END" +%s 2>/dev/null || echo "")"
  [ -n "$END_TS" ] || continue
  DAYS=$(( (END_TS - NOW) / 86400 ))
  if [ "$DAYS" -lt 20 ]; then
    echo "✗ $DOMAIN yenileme sonrasi hala $DAYS gun omurlu — yenileme calismiyor" >&2
    printf '%s ALARM domain=%s days_left=%s\n' "$(date -u +%FT%TZ)" "$DOMAIN" "$DAYS" >> "$ALARM_LOG"
    node "$(dirname "$0")/notify.mjs" \
      "SSL yenilenmiyor: $DOMAIN" \
      "Yenileme turundan sonra sertifikanin omru $DAYS gun. Sure dolarsa adres HTTPS vermeyi birakir.
Kontrol: sudo $(dirname "$0")/ssl-renew.sh" \
      critical || true
    FAILED=1
  fi
done <<EOF
$DOMAINS
EOF

# --- OZEL (UCRETLI CA) SERTIFIKALAR ---
#
# certbot bunlari bilmez ve yenilemez; yukarıdaki döngü onlara hiç dokunmaz.
# Sessizce dolmalarına izin vermemek için bitişe 30/14/7 gün kala (ve dolmuşsa
# her gece) Telegram'a bildirilir. Panel domains.ssl_expiry'yi yüklerken
# sertifikadan okuduğu için tarih gerçektir.
CUSTOM_ROWS="$(node "$DB_QUERY" \
  "SELECT domain_name, EXTRACT(DAY FROM (ssl_expiry - now()))::int FROM domains WHERE ssl_type='custom' AND ssl_status=TRUE AND ssl_expiry IS NOT NULL" \
  2>/dev/null || true)"
while IFS=$'\t' read -r CDOMAIN CDAYS; do
  [ -n "${CDOMAIN:-}" ] && [ -n "${CDAYS:-}" ] || continue
  if [ "$CDAYS" -le 0 ] || [ "$CDAYS" = "7" ] || [ "$CDAYS" = "14" ] || [ "$CDAYS" = "30" ]; then
    printf '%s ALARM domain=%s custom_days_left=%s\n' "$(date -u +%FT%TZ)" "$CDOMAIN" "$CDAYS" >> "$ALARM_LOG"
    node "$(dirname "$0")/notify.mjs" \
      "Ücretli SSL bitiyor: $CDOMAIN" \
      "Panelden yüklenen sertifika $CDAYS gün sonra bitiyor. Otomatik yenilenmez: CA'dan yenileyin, yeni CSR üretip CRT'yi panelden yükleyin (Domain > SSL)." \
      critical || true
  fi
done <<EOF2
$CUSTOM_ROWS
EOF2

exit "$FAILED"
