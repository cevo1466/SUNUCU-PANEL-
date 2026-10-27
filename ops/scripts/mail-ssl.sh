#!/usr/bin/env bash
# ops/scripts/mail-ssl.sh <domain>
#
# `mail.<domain>` icin GERCEK (Let's Encrypt) sertifika alir ve posta
# servislerinin o adi SNI ile sunmasini saglar.
#
# NEDEN VAR (gercek olay, 2026-09-05): kullanici iPhone'a hesabi kurmaya
# calisti ve "IMAP sunucusu yanit vermiyor" hatasi aldi. Girdigi bilgilerin
# hepsi dogruydu. Olculen gercekler:
#   - 993 disaridan ACIK (bagimsiz 4 noktadan dogrulandi, Istanbul 12 ms),
#   - dovecot yerelde sorunsuz cevap veriyor,
#   - ama sundugu sertifika KENDINDEN IMZALI ve adi `smtp.ornek.test`.
# iOS, adi tutmayan kendinden imzali sertifikada cogu zaman "guveniyor
# musunuz" bile sormaz; dogrudan "sunucu yanit vermiyor" der. Yani hata
# mesaji sebebi GIZLIYORDU.
#
# Bu script tekrar calistirilabilir (idempotent): var olan sertifikayi
# yeniden almaz, ayni satirlari config'e ikinci kez eklemez.
#
# SONUNDA GERCEKTEN OLCER: openssl ile baglanip sunulan sertifikanin adini
# dogrular. "Yaptim" deyip yapmamak bu projedeki en pahali hata bicimi.
#
# Root ile (sudo) calistirilmali.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanim: $0 <domain>   (ornek: $0 example.com)"
DOMAIN="$1"

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Gecersiz alan adi: $DOMAIN"

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $DOMAIN' ile calistirin."

HOST="mail.$DOMAIN"
LIVE="/etc/letsencrypt/live/$HOST"
# Port 80'deki default_server bu dizini HER bilinmeyen ad icin ACME
# dogrulamasina aciyor (bkz. ops/nginx/studio-panel.conf), bu yuzden
# `mail.` icin ayri bir nginx blogu gerekmiyor.
WEBROOT="/var/www/vhosts/_acme"
DOVECOT_CONF="/etc/dovecot/dovecot.conf"
POSTFIX_SNI="/etc/postfix/sni.map"
HOOK="/etc/letsencrypt/renewal-hooks/deploy/studio-panel-mail-reload.sh"

command -v certbot >/dev/null 2>&1 || fail "certbot kurulu degil (apk add certbot)."
command -v doveconf >/dev/null 2>&1 || fail "dovecot kurulu degil."
command -v postconf >/dev/null 2>&1 || fail "postfix kurulu degil."

# --- 1) Sertifika ---------------------------------------------------------
# --keep-until-expiring: script tekrar calistirilirsa Let's Encrypt oran
# sinirini bosa harcamaz.
certbot certonly --webroot -w "$WEBROOT" -d "$HOST" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --keep-until-expiring \
  || fail "certbot basarisiz. $HOST'un 80 portundan disaridan erisilebildigini dogrulayin."

[ -f "$LIVE/fullchain.pem" ] || fail "Sertifika dosyasi bulunamadi: $LIVE/fullchain.pem"

# --- 2) Dovecot (IMAP 993/143, POP3 995/110) ------------------------------
# local_name = TLS SNI. Tek sunucu birden fazla posta adini barindirir ve her
# ad KENDI sertifikasini sunar; varsayilan sertifika yalnizca SNI gondermeyen
# eski istemciler icin geride kalir.
if grep -q "^local_name $HOST {" "$DOVECOT_CONF"; then
  echo "» dovecot: $HOST zaten tanimli, dokunulmadi"
else
  cat >> "$DOVECOT_CONF" <<EOF
local_name $HOST {
  ssl_server {
    cert_file = $LIVE/fullchain.pem
    key_file = $LIVE/privkey.pem
  }
}
EOF
  echo "» dovecot: $HOST eklendi"
fi
doveconf -n >/dev/null 2>&1 || fail "dovecot config gecersiz — $DOVECOT_CONF elle kontrol edin."
dovecot reload

# --- 3) Postfix (SMTP 465/587) --------------------------------------------
# AYNI SORUN GIDEN POSTADA DA VAR: kullanici IMAP'i duzeltip SMTP'de yine
# sertifika uyarisi alirsa is yarim kalir.
#
# `hash:` BU SISTEMDE YOK: Alpine'in postfix'i Berkeley DB olmadan derlenmis
# ("Berkeley DB support ... is not available for this OS distribution").
# `lmdb:` destekleniyor ve `postconf -m` ile dogrulandi.
touch "$POSTFIX_SNI"
if grep -q "^$HOST " "$POSTFIX_SNI"; then
  echo "» postfix: $HOST zaten tanimli, dokunulmadi"
else
  echo "$HOST $LIVE/privkey.pem $LIVE/fullchain.pem" >> "$POSTFIX_SNI"
  echo "» postfix: $HOST eklendi"
fi
# -F: haritadaki degerler DOSYA YOLU; bu bayrak olmadan postmap yollari
# okumaya calisip basarisiz olur.
postmap -F "lmdb:$POSTFIX_SNI"
postconf -e "tls_server_sni_maps = lmdb:$POSTFIX_SNI"
postfix reload >/dev/null 2>&1 || fail "postfix reload basarisiz."

# --- 4) Yenileme sonrasi reload -------------------------------------------
# SESSIZ ARIZA RISKI: certbot 60 gun sonra sertifikayi yeniler ama dovecot ve
# postfix onlari yalnizca BASLANGICTA okur. Hook olmazsa posta servisleri
# suresi dolmus sertifika sunmaya devam eder ve bunu ancak musteri
# "telefonda mail calismiyor" dediginde ogreniriz.
if [ ! -x "$HOOK" ]; then
  mkdir -p "$(dirname "$HOOK")"
  cat > "$HOOK" <<'EOF'
#!/bin/sh
# Studio Panel — sertifika yenilendikten sonra posta servislerini yeniden
# yukler. dovecot ve postfix sertifikalari yalnizca baslangicta okur.
# ops/scripts/mail-ssl.sh tarafindan kurulur.
dovecot reload 2>/dev/null || true
postfix reload 2>/dev/null || true
EOF
  chmod +x "$HOOK"
  echo "» yenileme hook'u kuruldu: $HOOK"
else
  echo "» yenileme hook'u zaten kurulu"
fi

# --- 5) GERCEKTEN OLC -----------------------------------------------------
# Config'e satir yazmis olmak sertifikanin sunuldugu anlamina gelmez.
check_cert() {
  _port="$1"; _label="$2"; _starttls="${3:-}"
  if [ -n "$_starttls" ]; then
    _subject="$(echo | openssl s_client -connect "127.0.0.1:$_port" -starttls "$_starttls" \
      -servername "$HOST" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)"
  else
    _subject="$(echo | openssl s_client -connect "127.0.0.1:$_port" \
      -servername "$HOST" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)"
  fi
  case "$_subject" in
    *"CN=$HOST"*) echo "  ✓ $_label ($_port): $HOST" ;;
    "") fail "$_label ($_port) sertifika sunmadi — servis calisiyor mu?" ;;
    *) fail "$_label ($_port) YANLIS sertifika sunuyor: $_subject" ;;
  esac
}

echo "== Sunulan sertifika dogrulaniyor"
check_cert 993 "IMAPS"
check_cert 995 "POP3S"
check_cert 465 "SMTPS"
check_cert 587 "Submission" "smtp"

echo "✓ $HOST icin posta TLS hazir (IMAP/POP3/SMTP gecerli sertifika sunuyor)."
