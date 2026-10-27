#!/usr/bin/env bash
# ops/scripts/webmail-ssl.sh <domain>
#
# `webmail.<domain>` icin Let's Encrypt sertifikasi alir ve o hostname icin
# HTTPS server blogunu yazar.
#
# NEDEN AYRI SCRIPT (ssl-issue.sh degil): ssl-issue.sh bir DOMAIN'in kendi
# vhost'unu (ops/generated/<domain>.conf) hedefliyor ve o dosyadaki yorumlu
# HTTPS blogunu aciyor. Webmail'in vhost'u ise domain basina uretilmiyor —
# tek bir joker blok (`server_name ~^webmail\.`) tum adlari karsiliyor.
# Sertifika ise joker OLAMAZ: HTTP-01 dogrulamasi her ad icin ayri yapilir.
# Bu yuzden sertifikasi olan her webmail adi icin ayri, kucuk bir HTTPS blogu
# uretiliyor; HTTP ve ACME'yi ortak joker blok karsilamaya devam ediyor.
#
# Root ile (sudo) calistirilmali. Gercek nginx `proxy-server` konteynerinde;
# ssl-issue.sh / deploy-vhost.sh ile AYNI `docker exec` deseni kullaniliyor.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanim: $0 <domain>   (ornek: $0 musteri.test)"
DOMAIN="$1"

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Gecersiz alan adi: $DOMAIN"

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $DOMAIN' ile calistirin."

HOST="webmail.$DOMAIN"
# Joker blogun ACME webroot'u ile AYNI dizin (ops/nginx/webmail.conf.example).
WEBROOT="/var/www/vhosts/_acme"
CONF="/etc/nginx/conf.d/webmail-ssl.$DOMAIN.conf"
LIVE="/etc/letsencrypt/live/$HOST"

command -v certbot >/dev/null 2>&1 || fail "certbot kurulu degil (apk add certbot)."

# DNS gercekten bu sunucuyu gosteriyor mu? Gostermiyorsa certbot zaten
# basarisiz olur ama hata mesaji "dogrulama basarisiz" gibi genel olur;
# sebebi burada acikca soyluyoruz.
# Adin GERCEKTEN var olup olmadigi.
#
# `getent` TEK BASINA YETMEZ: yerel cozumleyici (Docker'in gomulu DNS'i)
# NEGATIF cevaplari onbellege aliyor ve Cloudflare'in SOA minimum'u kadar
# (30 dakika) "yok" demeye devam ediyor. Kayit Cloudflare'de acildiktan
# hemen sonra otoriter sunucu dogru cevabi veriyorken `getent` hala
# NXDOMAIN donuyordu; webmail sertifikasi bu yuzden hic kurulamiyordu
# (2026-09-02, webmail.testsite.ornek.test).
#
# Cozum: otoriter sunucuya DOGRUDAN sormak. SOA kaydi, ad var olmasa bile
# ust bolgeden geldigi icin bu yontem NXDOMAIN durumunda da calisir.
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

RESOLVED="$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -z "$RESOLVED" ] && resolves_host "$HOST"; then
  # Otoriter sunucu adi biliyor ama yerel cozumleyici negatif onbellekte.
  # Certbot'un kendi cozumleyicisi bizim onbellegimizi paylasmaz, bu yuzden
  # islem DURDURULMAZ (bkz. resolves_host aciklamasi).
  RESOLVED="$(dig +short "$HOST" A @"$(dig +noall +authority +answer "$HOST" SOA 2>/dev/null | awk '$4=="SOA"{print $5; exit}')" 2>/dev/null | head -1)"
fi
[ -n "$RESOLVED" ] || fail "$HOST cozumlenmiyor. Once A kaydini olusturun."
echo "» $HOST -> $RESOLVED"

mkdir -p "$WEBROOT/.well-known/acme-challenge"

echo "» Let's Encrypt sertifikasi isteniyor: $HOST"
certbot certonly --webroot -w "$WEBROOT" -d "$HOST" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --keep-until-expiring \
  || fail "certbot basarisiz. $HOST'un 80 portundan disaridan erisilebildigini dogrulayin."

[ -f "$LIVE/fullchain.pem" ] || fail "Sertifika dosyasi bulunamadi: $LIVE/fullchain.pem"

# /etc/letsencrypt bu konteyner ile proxy-server ARASINDA PAYLASILMIYOR —
# yalnizca /var/www/vhosts ve /etc/nginx/conf.d bind-mount. Sertifikayi
# kopyalamadan nginx onu goremez ve `nginx -t`
#   "cannot load certificate ... BIO_new_file() failed ... No such file"
# ile duser. (Bu tam olarak yasandi: certbot basariyla sertifika uretti,
# nginx dogrulamasi yine de basarisiz oldu.)
# ssl-issue.sh ile AYNI cozum: -L ile sembolik linkler cozulerek kopyalanir;
# nginx yalnizca bu iki dosyayi okudugu icin certbot'un archive/ yapisini
# konteynerde yeniden kurmaya gerek yok.
echo "» Sertifika proxy-server konteynerine kopyalaniyor"
docker exec proxy-server mkdir -p "$LIVE"
docker cp -L "$LIVE/fullchain.pem" "proxy-server:$LIVE/fullchain.pem"
docker cp -L "$LIVE/privkey.pem" "proxy-server:$LIVE/privkey.pem"

# Eski config varsa geri donebilmek icin gecici kopya (islem sonunda silinir —
# kalici .yedek dosyasi BIRAKILMAZ).
TMP_OLD=""
if [ -f "$CONF" ]; then
  TMP_OLD="$(mktemp)"
  cp "$CONF" "$TMP_OLD"
fi

cat > "$CONF" <<EOF
# $HOST — HTTPS. ops/scripts/webmail-ssl.sh tarafindan uretildi, ELLE DUZENLEME.
# HTTP ve ACME dogrulamasi ortak joker blokta (webmail.conf).
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $HOST;

    ssl_certificate     $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;

    # Guvenlik basliklari — YALNIZCA bu blokta (443). HTTP uzerinde HSTS
    # tarayici tarafindan zaten yok sayilir. `always` sart: onsuz nginx
    # basligi 404/500 yanitlarina eklemez.
    # Webmail bir posta arayuzu: cerceve icine alinmasi (clickjacking) ozellikle
    # tehlikeli, o yuzden burada SAMEORIGIN degil DENY.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options           "DENY" always;
    add_header Permissions-Policy        "camera=(), microphone=(), geolocation=()" always;

    location / {
        proxy_pass http://172.19.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        client_max_body_size 40m;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

if ! docker exec proxy-server nginx -t >/dev/null 2>&1; then
  # Bozuk config'i BIRAKMA: eskiye don, reload etme.
  if [ -n "$TMP_OLD" ]; then cp "$TMP_OLD" "$CONF"; else rm -f "$CONF"; fi
  [ -n "$TMP_OLD" ] && rm -f "$TMP_OLD"
  docker exec proxy-server nginx -t 2>&1 | tail -3
  fail "nginx dogrulamasi basarisiz; eski yapilandirmaya donuldu, reload YAPILMADI."
fi
[ -n "$TMP_OLD" ] && rm -f "$TMP_OLD"

docker exec proxy-server nginx -s reload
echo "✓ $HOST artik HTTPS uzerinden yayinda."
