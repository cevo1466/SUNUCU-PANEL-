#!/usr/bin/env bash
# ops/scripts/ssl-issue.sh <domain>
#
# Bir domain icin GERCEK Let's Encrypt sertifikasi alir, sertifikayi nginx'in
# calistigi konteynere kopyalar ve vhost'un HTTPS blogunu aktiflestirir.
#
# BU SCRIPT'I PANEL CALISTIRIR. apps/api/src/routes/ssl.ts, dar kapsamli bir
# sudo kuraliyla (/etc/sudoers.d/studio-panel-ssl) burayi cagirir; kullanici
# panelde "Sertifikayi al ve kur" dedigi anda certbot gercekten calisir.
# 2026-09-01 oncesinde route yalnizca ops/generated/pending-ssl-requests.jsonl
# dosyasina bir satir yaziyordu ve o satiri kimse islemiyordu — kullanici 88
# kez istek olusturdu, hicbiri sertifikaya donusmedi. Elle de calistirilabilir:
#   sudo ops/scripts/ssl-issue.sh ornek.com
#
# Gercek nginx BU konteynerde DEGIL, ayri bir Docker konteynerinde
# (`proxy-server`) calisiyor — deploy-vhost.sh / webmail-ssl.sh ile AYNI
# `docker exec proxy-server` deseni burada da kullaniliyor.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanim: $0 <domain>"
DOMAIN="$1"

# apps/api/src/lib/domain.ts'teki HOSTNAME_RE ile birebir ayni desen.
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Gecersiz domain adi: $DOMAIN"

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $DOMAIN' ile calistirin."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEBROOT="/var/www/vhosts/${DOMAIN}/public"
# ACME dogrulama dosyalari MUSTERININ klasorune yazilmaz.
#
# Onceden -w olarak site koku veriliyordu; certbot orada bos bir
# `.well-known/acme-challenge/` birakiyordu ve kullanici dosya yoneticisinde
# kendi koymadigi bir klasor goruyordu (her yenilemede geri gelen). Artik
# webmail-ssl.sh ile AYNI ortak dizin kullaniliyor; vhost sablonu da bu yolu
# servis ediyor (eski konuma try_files ile geri dusuyor).
ACME_WEBROOT="/var/www/vhosts/_acme"
GENERATED_CONF="${PROJECT_ROOT}/ops/generated/${DOMAIN}.conf"
DEST_CONF="/etc/nginx/conf.d/${DOMAIN}.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

# --- Temizlik: bu script KALICI .bak DOSYASI BIRAKMAZ ---
# Onceki surum her calistirmada ops/generated/<domain>.conf.bak.<epoch> ve
# /etc/nginx/conf.d/<domain>.conf.bak.<epoch> uretiyordu; bunlar hic
# silinmiyordu (bkz. MEMORY.md "Yedek birakma"). Geri donus icin gereken kopya
# artik $WORK altinda tutuluyor ve cikista siliniyor.
WORK="$(mktemp -d)"
PROBE_FILE=""

# --- SAHIPLIK: bu script root olarak calisiyor, panel ise devuser ---
#
# root'un yazdigi her dosya root:root olur ve panel KENDI dosyasini bir daha
# yazamaz. 2026-09-01'de tam olarak bu yasandi: sertifika kuruldugu anda
# ops/generated/<domain>.conf root'a gecti ve "Nginx config uret" 500 vermeye
# basladi (EACCES). Ayni tuzak daha once DKIM anahtarinda da yasanmisti
# (bkz. MEMORY.md). Bu yuzden root'un dokundugu her sey, dokunmadan ONCEKI
# sahibine geri verilir.
restore_owner() { # <sahip> <yol...>
  local owner="$1"; shift
  [ -n "$owner" ] || return 0
  chown -R "$owner" "$@" 2>/dev/null || true
}
own_of() { stat -c '%u:%g' "$1" 2>/dev/null || true; }

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

cleanup() {
  rm -rf "$WORK"
  [ -n "$PROBE_FILE" ] && rm -f "$PROBE_FILE"
  return 0
}
trap cleanup EXIT

# --- On kosullar. Her biri KENDI sebebini soyler; panel bu satiri kullaniciya
#     oldugu gibi gosterir, bu yuzden mesajlar eyleme donuk olmali. ---
[ -d "$WEBROOT" ] || fail "Webroot yok: $WEBROOT — once panelde domaini olusturun (HTTP-01 dogrulamasi bu dizinden yapilir)."
[ -f "$GENERATED_CONF" ] || fail "Uretilmis nginx config yok: $GENERATED_CONF — once domain detayinda 'Nginx config uret' calistirin."
[ -f "$DEST_CONF" ] || fail "Domain henuz nginx'e alinmamis ($DEST_CONF yok) — once 'Nginx config uret' ile canliya alin; HTTP-01 dogrulamasi calisan bir HTTP sunucusu gerektirir."
command -v certbot >/dev/null 2>&1 || fail "certbot kurulu degil (apk add certbot)."
command -v docker >/dev/null 2>&1 || fail "docker bulunamadi (nginx proxy-server konteynerinde calisiyor)."

# --- DNS: ad cozumleniyor mu? ---
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
[ -n "$RESOLVED" ] || fail "$DOMAIN cozumlenmiyor. Once A kaydini olusturun ve yayilmasini bekleyin."
echo "» $DOMAIN -> $RESOLVED"

# --- HTTP-01 yolu gercekten calisiyor mu? ---
#
# Sadece "DNS cozumleniyor" yetmez: Let's Encrypt cozulen adrese BAGLANIP
# /.well-known/acme-challenge/ altindaki dosyayi okuyabilmeli. Burada birebir
# ayni yol denenir; boylece certbot'un genel "dogrulama basarisiz" hatasi
# yerine sebebi onceden soyleyebiliyoruz.
#
# ANCAK bu olcum tek yonlu guvenilir: sunucu KENDI genel IP'sine baglanamiyor
# (hairpin NAT yok — 2026-09-01'de dogrulandi: 203.0.113.10'e giden istek
# zaman asimina ugruyor). Yani A kaydi dogrudan bu sunucuyu gosteriyorsa
# olcum basarisiz olur ama dis dunyadan erisim GAYET calisir. Bu yuzden
# basarisiz olcum ISLEMI DURDURMAZ — sadece not edilir ve certbot yine de
# denenir. Aksi halde en yaygin, en dogru kurulum (dogrudan A kaydi) hicbir
# zaman sertifika alamazdi.
SERVER_IP="$(grep -E '^SERVER_PUBLIC_IP=' "$PROJECT_ROOT/.env.loopkit" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
PROBE_TOKEN="studio-panel-probe-$(date +%s)-$$"
PROBE_DIR="$ACME_WEBROOT/.well-known/acme-challenge"
PROBE_NOTE=""
# Ortak dizinin sahibi panel kullanicisi olmali; root olarak olusturulursa
# panel bir daha yazamaz (bkz. restore_owner aciklamasi).
ACME_OWNER="$(own_of "$ACME_WEBROOT")"
[ -n "$ACME_OWNER" ] || ACME_OWNER="$(own_of "$(dirname "$WEBROOT")")"
mkdir -p "$PROBE_DIR"
restore_owner "$ACME_OWNER" "$ACME_WEBROOT"
PROBE_FILE="$PROBE_DIR/$PROBE_TOKEN"
printf '%s\n' "$PROBE_TOKEN" > "$PROBE_FILE"
chmod 644 "$PROBE_FILE"
PROBE_BODY="$(curl -fsS -m 15 -L "http://$DOMAIN/.well-known/acme-challenge/$PROBE_TOKEN" 2>/dev/null || true)"
if [ "$(printf '%s' "$PROBE_BODY" | tr -d '[:space:]')" = "$PROBE_TOKEN" ]; then
  echo "✓ HTTP-01 yolu disaridan erisilebilir."
elif [ -n "$SERVER_IP" ] && [ "$RESOLVED" = "$SERVER_IP" ]; then
  echo "» HTTP-01 on olcumu yapilamadi (A kaydi bu sunucunun kendi IP'sini gosteriyor; sunucu kendi genel IP'sine baglanamiyor). Certbot yine de deneniyor."
else
  PROBE_NOTE="Sunucu, $DOMAIN/.well-known/acme-challenge/ adresini $RESOLVED uzerinden okuyamadi — 80 portu disaridan kapali veya A kaydi baska bir sunucuyu gosteriyor olabilir."
  echo "» UYARI: $PROBE_NOTE Certbot yine de deneniyor."
fi
rm -f "$PROBE_FILE"
PROBE_FILE=""

# --- Sertifika ---
# --keep-until-expiring: panelde dugmeye ikinci kez basmak yeni bir sertifika
# ISTEMEZ, gecerli olan korunur. Let's Encrypt'in saatlik limitleri var; bunu
# koymamak, arka arkaya birkac tiklamada domaini limite takardi.
CERTBOT_EMAIL_ARGS=(--register-unsafely-without-email)
OWNER_EMAIL="$(grep -E '^PANEL_OWNER_EMAIL=' "$PROJECT_ROOT/.env.loopkit" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
[ -n "$OWNER_EMAIL" ] && CERTBOT_EMAIL_ARGS=(-m "$OWNER_EMAIL" --no-eff-email)

# --- Sertifikaya www de girsin ---
#
# nginx vhost'u zaten hem "alanadi" hem "www.alanadi" adini karsiliyor (bkz.
# nginxTemplate.ts serverNamesFor). Sertifika www'yi kapsamazsa tarayici
# www adresinde AD UYUSMAZLIGI hatasi verir — yani www calisir gorunur ama
# guvenli olmaz. www YALNIZCA cozumleniyorsa eklenir: cozumlenmeyen bir ad
# istemek TUM siparisi (apex dahil) basarisiz yapardi.
CERT_ARGS=(-d "$DOMAIN")
WWW_INCLUDED=0
case "$DOMAIN" in
  www.*) ;;
  *)
    if resolves_host "www.$DOMAIN"; then
      CERT_ARGS+=(-d "www.$DOMAIN")
      WWW_INCLUDED=1
      echo "» www.$DOMAIN cozumleniyor; sertifikaya ekleniyor."
    else
      echo "» www.$DOMAIN cozumlenmiyor; sertifikaya eklenmiyor. (www A kaydini ekleyip tekrar calistirin.)"
    fi
    ;;
esac

# --cert-name "$DOMAIN": ad listesi degistiginde (ornegin www eklendiginde)
# certbot YENI bir dizin acabiliyor (<domain>-0001) ve nginx eski yolu
# okumaya devam ederdi — sertifika yenilenir, site eskisini sunar. Sabit
# cert-name bunu imkansiz kilar.
# --expand: ad listesi buyudugunde mevcut sertifikayi genisletir.
run_certbot() {
  certbot certonly --webroot -w "$ACME_WEBROOT" "$@" \
    --cert-name "$DOMAIN" --non-interactive --agree-tos --expand \
    --keep-until-expiring "${CERTBOT_EMAIL_ARGS[@]}" 2>&1
}

echo "» Let's Encrypt sertifikasi isteniyor: $DOMAIN"
if ! run_certbot "${CERT_ARGS[@]}"; then
  # www yuzunden mi dustu? www BASKA bir sunucuyu gosteriyorsa dogrulama
  # basarisiz olur ve apex de birlikte batar. Asil alan adini kurtarmak
  # icin www'suz bir kez daha denenir — kullanicinin sitesi calissin,
  # www eksigi ayrica bildirilsin.
  if [ "$WWW_INCLUDED" = "1" ]; then
    echo "» UYARI: www.$DOMAIN ile dogrulama basarisiz. Yalnizca $DOMAIN ile tekrar deneniyor."
    WWW_INCLUDED=0
    if ! run_certbot -d "$DOMAIN"; then
      # Sebep once degiskene yaziliyor: `${VAR:-...}` icinde kesme isareti
      # bash tarafindan tirnak baslangici sayilir ve script sozdizimi hatasi
      # verir. (Kisayol denendi, `bash -n` yakaladi.)
      REASON="$PROBE_NOTE"
      [ -n "$REASON" ] || REASON="$DOMAIN adresinin 80 portundan disaridan erisilebildigini ve A kaydinin bu sunucuyu gosterdigini dogrulayin."
      fail "Certbot dogrulamayi tamamlayamadi (www olmadan yapilan deneme de basarisiz). $REASON"
    fi
  elif [ -n "$PROBE_NOTE" ]; then
    fail "Certbot dogrulamayi tamamlayamadi. $PROBE_NOTE"
  else
    fail "Certbot dogrulamayi tamamlayamadi. $DOMAIN'in 80 portundan disaridan erisilebildigini ve A kaydinin bu sunucuyu gosterdigini dogrulayin (yukaridaki certbot ciktisi sebebi yaziyor)."
  fi
fi

[ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ] \
  || fail "certbot basarili gorundu ama $CERT_DIR altinda sertifika dosyalari yok."

# certbot de ayni ortak dizine yaziyor; sahipligi tekrar geri veriyoruz.
restore_owner "$ACME_OWNER" "$ACME_WEBROOT"

echo "✓ Sertifika hazir: $CERT_DIR"

# --- Sertifikayi gercek nginx'in gordugu yere kopyala ---
# /etc/letsencrypt bu konteyner ile proxy-server ARASINDA PAYLASILMIYOR
# (yalnizca /var/www/vhosts ve /etc/nginx/conf.d bind-mount). Kopyalamadan
# nginx sertifikayi goremez ve `nginx -t`
#   "cannot load certificate ... BIO_new_file() failed ... No such file"
# ile duser. -L sembolik linkleri cozer; nginx yalnizca bu iki dosyayi okur,
# certbot'un archive/ yapisini konteynerde kurmaya gerek yok.
echo "» Sertifika proxy-server konteynerine kopyalaniyor..."
docker exec proxy-server mkdir -p "$CERT_DIR"
docker cp -L "$CERT_DIR/fullchain.pem" "proxy-server:$CERT_DIR/fullchain.pem"
docker cp -L "$CERT_DIR/privkey.pem" "proxy-server:$CERT_DIR/privkey.pem"

# --- vhost'un HTTPS blogunu aktiflestir ---
#
# IDEMPOTENT: config zaten HTTPS ise yeniden yazilmaz. Onceki surum her
# calistirmada GENERATED_CONF'taki "--- HTTPS (443..." isaretinden sonrasini
# ariyordu; ilk aktivasyondan sonra o isaret dosyada kalmadigi icin ikinci
# calistirma "Sablonda HTTPS blogu bulunamadi" ile patliyordu — yani sertifika
# yenilemek/yeniden kurmak mumkun degildi.
# DIKKAT: duz `grep "listen 443 ssl"` KULLANMA. Sablonun kendi HTTPS blogu
# "#     listen 443 ssl;" olarak YORUMLU duruyor ve ustteki aciklama metninde
# de gecen bir ifade; duz arama sertifikasiz bir config'i "zaten HTTPS" sanip
# aktivasyonu ATLAR (2026-09-01'de testsite.ornek.test'da tam olarak bu
# oldu: sertifika alindi, HTTPS acilmadi, Cloudflare 525 vermeye devam etti).
# Satir basinda, yorumsuz bir direktif aranmali.
if grep -qE "^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl" "$DEST_CONF"; then
  echo "» $DEST_CONF zaten HTTPS; config'e dokunulmuyor, yalnizca sertifika tazelendi."
else
  echo "» Sablondaki yorumlu HTTPS blogu aktiflestiriliyor..."
  # ops/generated/<domain>.conf apps/api/src/lib/nginxTemplate.ts tarafindan
  # zaten render edilmisti (HTTPS blogu dahil, "# " ile yorumlu). Burada
  # SADECE yorum isaretleri kaldiriliyor; sablon ikinci kez render edilmiyor.
  # AYNI KURAL TypeScript tarafinda da var (nginxTemplate.ts activateHttps) —
  # biri degisirse digeri de degismeli; self-test ikisinin ayni sonucu
  # urettigini dogrular.
  ACTIVATED="$(sed -n '/--- HTTPS (443, HTTP\/2)/,$p' "$GENERATED_CONF" | tail -n +2 | sed -E 's/^# ?//')"
  [ -n "$ACTIVATED" ] || fail "Sablonda HTTPS blogu bulunamadi — ops/nginx/templates/vhost.conf.tmpl degismis olabilir."

  printf '%s\n' "$ACTIVATED" > "$WORK/new.conf"
  cp "$DEST_CONF" "$WORK/dest.old"
  cp "$GENERATED_CONF" "$WORK/generated.old"
  # Sahipleri, uzerine yazmadan ONCE not al (bkz. restore_owner aciklamasi).
  DEST_OWNER="$(own_of "$DEST_CONF")"
  GEN_OWNER="$(own_of "$GENERATED_CONF")"
  cp "$WORK/new.conf" "$DEST_CONF"
  cp "$WORK/new.conf" "$GENERATED_CONF"
  restore_owner "$DEST_OWNER" "$DEST_CONF"
  restore_owner "$GEN_OWNER" "$GENERATED_CONF"

  echo "» proxy-server konteynerinde nginx -t..."
  if ! docker exec proxy-server nginx -t 2>&1; then
    echo "✗ nginx -t BASARISIZ — config geri alindi, reload YAPILMADI." >&2
    cp "$WORK/dest.old" "$DEST_CONF"
    cp "$WORK/generated.old" "$GENERATED_CONF"
    restore_owner "$DEST_OWNER" "$DEST_CONF"
    restore_owner "$GEN_OWNER" "$GENERATED_CONF"
    fail "Uretilen HTTPS config'i nginx kabul etmedi; eski yapilandirmaya donuldu."
  fi
fi

echo "» proxy-server konteynerinde nginx -t (son kontrol)..."
docker exec proxy-server nginx -t >/dev/null 2>&1 || fail "nginx -t basarisiz."
docker exec proxy-server nginx -s reload

# --- Sonucu makine okunur bicimde bildir ---
# Panel bitis tarihini ARTIK KULLANICIYA SORMUYOR; sertifikanin kendisinden
# okuyor. Elle girilen tarih tahminden ibaretti ve yenileme uyarilarini
# yanlis zamana kaydiriyordu.
# openssl'in iso_8601 bicimi ("2026-11-30 17:10:15Z") tercih edilir. Eski
# openssl'lerde -dateopt yok; o zaman busybox date ile ceviriyoruz. `date -d`
# TEK BASINA YETMEZ: busybox date, "Nov 30 17:10:15 2026 GMT" bicimini -D ile
# desen verilmeden ayristiramaz ve sessizce bos doner — bu durumda panel
# bitis tarihini okuyamaz ve basarili bir kurulumu "basarisiz" sayar.
# --- Webmail adresi de HTTPS olsun ---
#
# NEDEN BURADA: kullanicinin zihninde "bu alan adinin SSL'i" tek bir sey.
# Webmail sertifikasi ayri bir script'ti ve elle calistirilmasi gerekiyordu;
# sonuc olarak her yeni domainde panel "HTTPS yok" rozetini gosteriyor ve
# kimse o adimi atmiyordu. Artik ayni tikla kuruluyor.
#
# BASARISIZLIK OLUMCUL DEGIL: asil alan adinin sertifikasi zaten kuruldu ve
# calisiyor. Webmail'i kuramamak (cogunlukla DNS kaydi yoklugundan) o basariyi
# geri almaz — durum bildirilir, islem basarili sayilir.
WEBMAIL_HOST="webmail.$DOMAIN"
WEBMAIL_STATUS="atlandi"
if [ -x "$SCRIPT_DIR/webmail-ssl.sh" ]; then
  if resolves_host "$WEBMAIL_HOST"; then
    echo "» $WEBMAIL_HOST icin sertifika kuruluyor..."
    if WEBMAIL_OUT="$("$SCRIPT_DIR/webmail-ssl.sh" "$DOMAIN" 2>&1)"; then
      WEBMAIL_STATUS="kuruldu"
      echo "✓ $WEBMAIL_HOST HTTPS uzerinden yayinda."
    else
      WEBMAIL_STATUS="basarisiz"
      echo "» UYARI: $WEBMAIL_HOST sertifikasi alinamadi:"
      printf '%s\n' "$WEBMAIL_OUT" | tail -3
    fi
  else
    WEBMAIL_STATUS="dns-yok"
    echo "» $WEBMAIL_HOST cozumlenmiyor; webmail HTTPS atlandi. Once $WEBMAIL_HOST icin A kaydi ekleyin."
  fi
fi

EXPIRY_ISO="$(openssl x509 -enddate -noout -dateopt iso_8601 -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2 | tr ' ' 'T')"
if [ -z "$EXPIRY_ISO" ]; then
  EXPIRY_RAW="$(openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" | cut -d= -f2 | sed 's/ GMT$//')"
  EXPIRY_ISO="$(date -u -D '%b %d %H:%M:%S %Y' -d "$EXPIRY_RAW" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
fi
[ -n "$EXPIRY_ISO" ] || fail "Sertifika kuruldu ama bitis tarihi okunamadi: $CERT_DIR/fullchain.pem"

echo "✓ $DOMAIN artik HTTPS uzerinden yayinda (HTTP -> HTTPS yonlendirmesi dahil)."
echo "SSL_RESULT domain=$DOMAIN expiry=$EXPIRY_ISO www=$WWW_INCLUDED webmail=$WEBMAIL_STATUS"
