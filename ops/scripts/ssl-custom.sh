#!/usr/bin/env bash
# ops/scripts/ssl-custom.sh <komut> <domain> [secenek]
#
# Ucretli (ticari) CA sertifikalari icin Plesk tarzi yonetim: CSR uret, CA'dan
# gelen CRT + CA paketini kur, ayrintilari oku, kaldir.
#
#   csr     <domain>   stdin: ANAHTAR=DEGER satirlari  -> stdout: CSR (PEM)
#   install <domain>   stdin: ###CERT### / ###CHAIN### / ###KEY### bolumleri
#   info    <domain>   stdout: anahtar=deger satirlari (aktif sertifika)
#   pending <domain>   stdout: bekleyen CSR (PEM)
#   remove  <domain> [--http-only]
#
# BU SCRIPT'I PANEL CALISTIRIR (apps/api/src/routes/ssl.ts, sudoers:
# /etc/sudoers.d/studio-panel-ssl). Elle de calistirilabilir.
#
# Dosyalar: /etc/letsencrypt/custom/<domain>/ (root, 0700). certbot'un live/
# ve archive/ dizinlerine DOKUNULMAZ: ssl-renew.sh `certbot certificates`
# listesinden gittigi icin ozel sertifikayi yenilemeye calismaz ve Let's
# Encrypt "yenile" dugmesi ozel sertifikayi sessizce ezemez. /etc/letsencrypt
# proxy-server ile PAYLASILMIYOR (bkz. ssl-issue.sh); sertifika `docker cp -L`
# ile ayni yola kopyalanir.
set -euo pipefail
umask 077

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -ge 2 ] || fail "Kullanim: $0 <csr|install|info|pending|remove> <domain> [--http-only]"
CMD="$1"
DOMAIN="$2"
OPT="${3:-}"

# apps/api/src/lib/domain.ts'teki HOSTNAME_RE ile birebir ayni desen.
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Gecersiz domain adi: $DOMAIN"
[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $CMD $DOMAIN' ile calistirin."
command -v openssl >/dev/null 2>&1 || fail "openssl kurulu degil (apk add openssl)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LE_ROOT="/etc/letsencrypt"
CUSTOM_DIR="$LE_ROOT/custom/$DOMAIN"
LIVE_DIR="$LE_ROOT/live/$DOMAIN"
GENERATED_CONF="${PROJECT_ROOT}/ops/generated/${DOMAIN}.conf"
DEST_CONF="/etc/nginx/conf.d/${DOMAIN}.conf"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

own_of() { stat -c '%u:%g' "$1" 2>/dev/null || true; }
restore_owner() { # <sahip> <yol...>  (bkz. ssl-issue.sh: root'un yazdigi conf panele kapanmasin)
  local owner="$1"; shift
  [ -n "$owner" ] || return 0
  chown -R "$owner" "$@" 2>/dev/null || true
}

has_live_https() { grep -qE "^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl" "$DEST_CONF"; }

# DN degerlerinde openssl yapilandirmasini bozacak karakterler reddedilir.
safe_dn() { # <alan> <deger> <azami-uzunluk>
  local v="$2"
  [ "${#v}" -le "$3" ] || fail "$1 en fazla $3 karakter olabilir."
  case "$v" in
    *[\$\\\"/\`\;=]*|*$'\n'*|*$'\r'*) fail "$1 alaninda gecersiz karakter var (\$ \\ \" / \` ; = veya satir sonu)." ;;
  esac
}

# vhost icindeki ssl_certificate* satirlarini bir dizinden digerine cevirir.
# cp ile yazar (rename degil): /etc/nginx/conf.d proxy-server ile bind-mount.
repoint_conf() { # <conf> <eski-dizin> <yeni-dizin>
  local conf="$1" from="$2" to="$3" tmp
  tmp="$(mktemp -p "$WORK")"
  sed -E "/^[[:space:]]*ssl_certificate(_key)?[[:space:]]/ s#${from//./\\.}/#${to}/#g" "$conf" > "$tmp"
  cat "$tmp" > "$conf"
}

# nginx -t basarisizsa vhost'u geri alir. Tek ortak nginx tum domainleri
# sunuyor: bozuk bir vhost hepsini etkiler.
reload_or_rollback() { # <aciklama>
  if ! docker exec proxy-server nginx -t >"$WORK/nginx-t.log" 2>&1; then
    cat "$WORK/nginx-t.log" >&2
    [ -f "$WORK/dest.old" ] && cat "$WORK/dest.old" > "$DEST_CONF"
    [ -f "$WORK/generated.old" ] && cat "$WORK/generated.old" > "$GENERATED_CONF"
    # Yeni yazilan sertifika dosyalari da geri alinir (ilk kurulumda silinir).
    if [ "$CMD" = "install" ]; then
      for f in cert.pem chain.pem fullchain.pem privkey.pem; do
        if [ -f "$WORK/prev/$f" ]; then cat "$WORK/prev/$f" > "$CUSTOM_DIR/$f"; else rm -f "$CUSTOM_DIR/$f"; fi
      done
    fi
    restore_owner "${DEST_OWNER:-}" "$DEST_CONF"
    restore_owner "${GEN_OWNER:-}" "$GENERATED_CONF"
    fail "nginx -t basarisiz; eski yapilandirmaya donuldu. ($1)"
  fi
  docker exec proxy-server nginx -s reload
}

snapshot_confs() {
  cp "$DEST_CONF" "$WORK/dest.old"
  [ -f "$GENERATED_CONF" ] && cp "$GENERATED_CONF" "$WORK/generated.old"
  DEST_OWNER="$(own_of "$DEST_CONF")"
  GEN_OWNER="$(own_of "$GENERATED_CONF")"
}

copy_to_proxy() { # <dizin> : fullchain.pem + privkey.pem
  docker exec proxy-server mkdir -p "$1"
  docker cp -L "$1/fullchain.pem" "proxy-server:$1/fullchain.pem"
  docker cp -L "$1/privkey.pem" "proxy-server:$1/privkey.pem"
}

cert_expiry_iso() { # <pem>
  local iso raw
  iso="$(openssl x509 -enddate -noout -dateopt iso_8601 -in "$1" 2>/dev/null | cut -d= -f2 | tr ' ' 'T')"
  if [ -z "$iso" ]; then
    # Eski openssl: busybox date -D ile cevir (bkz. ssl-issue.sh).
    raw="$(openssl x509 -enddate -noout -in "$1" | cut -d= -f2 | sed 's/ GMT$//')"
    iso="$(date -u -D '%b %d %H:%M:%S %Y' -d "$raw" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  fi
  printf '%s' "$iso"
}

pubkey_hash() { # <cert|key> <dosya>
  if [ "$1" = "cert" ]; then
    openssl x509 -in "$2" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null | awk '{print $NF}'
  else
    openssl pkey -in "$2" -passin pass: -pubout 2>/dev/null | openssl sha256 2>/dev/null | awk '{print $NF}'
  fi
}

# ---------------------------------------------------------------- csr
cmd_csr() {
  local CN="" SAN="" O="" OU="" C="" ST="" L="" EMAIL="" KEYTYPE="rsa2048" line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      CN) CN="$v" ;; SAN) SAN="$v" ;; O) O="$v" ;; OU) OU="$v" ;; C) C="$v" ;;
      ST) ST="$v" ;; L) L="$v" ;; EMAIL) EMAIL="$v" ;; KEY) KEYTYPE="$v" ;;
      *) fail "Bilinmeyen alan: $k" ;;
    esac
  done

  [ -n "$CN" ] || fail "Ortak ad (CN) gerekli."
  [[ "$CN" =~ ^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
    || fail "Gecersiz ortak ad: $CN"
  [[ -z "$C" || "$C" =~ ^[A-Za-z]{2}$ ]] || fail "Ulke kodu 2 harf olmali (ornek: TR)."
  [[ -z "$EMAIL" || "$EMAIL" =~ ^[^[:space:]@\$\\\"/\`\;=]+@[^[:space:]@\$\\\"/\`\;=]+$ ]] || fail "Gecersiz e-posta."
  safe_dn "Kurum" "$O" 64; safe_dn "Birim" "$OU" 64; safe_dn "Il" "$ST" 64; safe_dn "Ilce" "$L" 64

  # SAN: virgullu liste; her biri alan adi. CN her zaman listeye girer
  # (modern tarayicilar yalnizca SAN'a bakar).
  local sans_cfg="" i=1 name seen="," names
  IFS=',' read -ra names <<<"$CN,$SAN"
  for name in "${names[@]}"; do
    name="${name//[[:space:]]/}"
    [ -n "$name" ] || continue
    [[ "$name" =~ ^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
      || fail "Gecersiz alternatif ad: $name"
    case "$seen" in *",$name,"*) continue ;; esac
    seen="$seen$name,"
    sans_cfg="${sans_cfg}DNS.${i} = ${name}"$'\n'
    i=$((i + 1))
  done
  [ "$i" -le 101 ] || fail "En fazla 100 alternatif ad girilebilir."

  local keyargs
  case "$KEYTYPE" in
    rsa2048) keyargs=(-newkey rsa:2048) ;;
    rsa4096) keyargs=(-newkey rsa:4096) ;;
    ec256)   keyargs=(-newkey ec -pkeyopt ec_paramgen_curve:prime256v1) ;;
    *) fail "Anahtar turu rsa2048, rsa4096 veya ec256 olmali." ;;
  esac

  {
    echo "[req]"
    echo "distinguished_name = dn"
    echo "req_extensions = ext"
    echo "prompt = no"
    echo "utf8 = yes"
    echo "string_mask = utf8only"
    echo "[dn]"
    [ -n "$C" ]     && echo "C = $(printf '%s' "$C" | tr 'a-z' 'A-Z')"
    [ -n "$ST" ]    && echo "ST = $ST"
    [ -n "$L" ]     && echo "L = $L"
    [ -n "$O" ]     && echo "O = $O"
    [ -n "$OU" ]    && echo "OU = $OU"
    echo "CN = $CN"
    [ -n "$EMAIL" ] && echo "emailAddress = $EMAIL"
    echo "[ext]"
    echo "subjectAltName = @alt"
    echo "[alt]"
    printf '%s' "$sans_cfg"
  } > "$WORK/csr.cnf"

  install -d -m 0700 "$LE_ROOT/custom" "$CUSTOM_DIR"
  # Bekleyen anahtar: aktif sertifikanin anahtarini EZMEZ. CA'dan gelen CRT
  # kurulana kadar siteyi sunan anahtar yerinde kalir.
  openssl req -new "${keyargs[@]}" -nodes -config "$WORK/csr.cnf" \
    -keyout "$WORK/pending.key" -out "$WORK/pending.csr" 2>"$WORK/openssl.log" \
    || fail "CSR uretilemedi: $(tail -2 "$WORK/openssl.log" | tr '\n' ' ')"
  openssl req -in "$WORK/pending.csr" -noout -verify 2>/dev/null || fail "Uretilen CSR dogrulanamadi."

  cat "$WORK/pending.key" > "$CUSTOM_DIR/pending.key"
  cat "$WORK/pending.csr" > "$CUSTOM_DIR/pending.csr"
  chmod 600 "$CUSTOM_DIR/pending.key" "$CUSTOM_DIR/pending.csr"
  cat "$WORK/pending.csr"
}

# ------------------------------------------------------------ install
cmd_install() {
  [ -f "$DEST_CONF" ] || fail "Domain henuz nginx'e alinmamis ($DEST_CONF yok) — once 'Nginx config uret' ile canliya alin."
  [ -f "$GENERATED_CONF" ] || fail "Uretilmis nginx config yok: $GENERATED_CONF — once domain detayinda 'Nginx config uret' calistirin."
  command -v docker >/dev/null 2>&1 || fail "docker bulunamadi (nginx proxy-server konteynerinde calisiyor)."

  # stdin'i bolumlere ayir.
  awk -v dir="$WORK" '
    /^###CERT###$/  { out = dir "/cert.in";  next }
    /^###CHAIN###$/ { out = dir "/chain.in"; next }
    /^###KEY###$/   { out = dir "/key.in";   next }
    out != ""       { print > out }
  '
  [ -s "$WORK/cert.in" ] || fail "Sertifika (CRT) bos."

  # Her girdiden yalnizca PEM bloklarini al; baska metni (CA e-postasindaki
  # aciklamalar vb.) at. Ozel anahtar bloklari CRT/CA alanindan REDDEDILIR:
  # yanlis alana yapistirilan anahtar sertifika dosyasina yazilirdi.
  extract_certs() { awk '/-----BEGIN CERTIFICATE-----/{p=1} p{print} /-----END CERTIFICATE-----/{p=0}' "$1"; }
  if grep -q "PRIVATE KEY" "$WORK/cert.in" "$WORK/chain.in" 2>/dev/null; then
    fail "CRT veya CA paketi alaninda OZEL ANAHTAR var. Anahtari 'Ozel anahtar' alanina yapistirin."
  fi
  extract_certs "$WORK/cert.in" > "$WORK/cert.all"
  [ -s "$WORK/cert.all" ] || fail "CRT alaninda gecerli bir '-----BEGIN CERTIFICATE-----' blogu yok."
  [ -f "$WORK/chain.in" ] && extract_certs "$WORK/chain.in" > "$WORK/chain.extra" || : > "$WORK/chain.extra"

  # Ilk blok yaprak sertifika; CRT alanina tam paket yapistirildiysa gerisi zincirdir.
  awk -v dir="$WORK" '
    /-----BEGIN CERTIFICATE-----/ { n++ }
    n == 1 { print > (dir "/leaf.pem") }
    n >= 2 { print > (dir "/chain.fromcert") }
  ' "$WORK/cert.all"
  [ -f "$WORK/chain.fromcert" ] || : > "$WORK/chain.fromcert"
  cat "$WORK/chain.fromcert" "$WORK/chain.extra" > "$WORK/chain.pem"

  openssl x509 -in "$WORK/leaf.pem" -noout 2>/dev/null || fail "Sertifika okunamadi (bozuk PEM)."
  openssl x509 -in "$WORK/leaf.pem" -noout -checkend 0 >/dev/null 2>&1 \
    || fail "Sertifikanin suresi dolmus."

  # CA yaprak yerine ara sertifikayi/koku ilk sirada gondermis olabilir.
  if openssl x509 -in "$WORK/leaf.pem" -noout -text 2>/dev/null | grep -q "CA:TRUE"; then
    fail "Yuklenen ilk sertifika bir CA sertifikasi (CA:TRUE). Alan adi sertifikasini (CRT) CRT alanina, CA paketini CA alanina koyun."
  fi

  # Alan adi kapsami. Uyusmayan sertifika kurulursa tarayici ad uyusmazligi
  # hatasi gosterir — sert hata, uyari degil.
  openssl x509 -in "$WORK/leaf.pem" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q "does match" \
    || fail "Sertifika $DOMAIN adini kapsamiyor. Sertifikanin CN/SAN listesini kontrol edin (info: $(openssl x509 -in "$WORK/leaf.pem" -noout -subject 2>/dev/null | sed 's/^subject= *//'))."
  WWW=0
  openssl x509 -in "$WORK/leaf.pem" -noout -checkhost "www.$DOMAIN" 2>/dev/null | grep -q "does match" && WWW=1

  # Ozel anahtar: yuklenen > CSR'dan bekleyen > mevcut aktif (ayni anahtarla
  # yenileme). Yuklenen yoksa SERTIFIKAYLA ESLESEN ilk aday secilir; terk
  # edilmis bir CSR, ayni anahtarla yenilemeyi engellemesin.
  CERT_H="$(pubkey_hash cert "$WORK/leaf.pem")"
  [ -n "$CERT_H" ] || fail "Sertifikanin acik anahtari okunamadi."
  KEYSRC=""
  if [ -s "$WORK/key.in" ]; then
    awk '/-----BEGIN [A-Z ]*PRIVATE KEY-----/{p=1} p{print} /-----END [A-Z ]*PRIVATE KEY-----/{p=0}' "$WORK/key.in" > "$WORK/key.pem"
    [ -s "$WORK/key.pem" ] || fail "Ozel anahtar alaninda gecerli bir PEM blogu yok."
    grep -q "ENCRYPTED" "$WORK/key.pem" && fail "Ozel anahtar parola korumali. Parolasini kaldirin: openssl rsa -in key.pem -out key-nopass.pem"
    openssl pkey -in "$WORK/key.pem" -passin pass: -noout 2>/dev/null || fail "Ozel anahtar okunamadi (bozuk PEM)."
    [ "$(pubkey_hash key "$WORK/key.pem")" = "$CERT_H" ] || fail "Sertifika ile yuklenen ozel anahtar eslesmiyor."
    KEYSRC="uploaded"
  else
    for cand in "csr:$CUSTOM_DIR/pending.key" "current:$CUSTOM_DIR/privkey.pem"; do
      [ -f "${cand#*:}" ] || continue
      if [ "$(pubkey_hash key "${cand#*:}")" = "$CERT_H" ]; then
        cat "${cand#*:}" > "$WORK/key.pem"; KEYSRC="${cand%%:*}"; break
      fi
    done
    if [ -z "$KEYSRC" ]; then
      if [ -f "$CUSTOM_DIR/pending.key" ]; then
        fail "Sertifika, bu domain icin uretilen CSR'in anahtariyla eslesmiyor. CA'ya GONDERDIGINIZ CSR ile uretilen sertifikayi yuklediginizden emin olun (CSR'i yeniden olusturduysaniz eskisi gecersizdir) veya ozel anahtari da yukleyin."
      fi
      fail "Eslesen ozel anahtar yok. Once panelden CSR olusturun veya ozel anahtari yukleyin."
    fi
  fi

  # Zincir. Kendinden imzali sertifika zincir gerektirmez; digerlerinde eksik
  # ara sertifika Cloudflare "Full (strict)" altinda 525, tarayicida
  # "zincir eksik" uyarisi demektir.
  CHAIN_STATE="ok"
  ISSUER_H="$(openssl x509 -in "$WORK/leaf.pem" -noout -issuer_hash 2>/dev/null)"
  SUBJECT_H="$(openssl x509 -in "$WORK/leaf.pem" -noout -subject_hash 2>/dev/null)"
  if [ "$ISSUER_H" = "$SUBJECT_H" ] && [ ! -s "$WORK/chain.pem" ]; then
    CHAIN_STATE="selfsigned"
  else
    VERIFY_ARGS=()
    [ -s "$WORK/chain.pem" ] && VERIFY_ARGS=(-untrusted "$WORK/chain.pem")
    if ! openssl verify "${VERIFY_ARGS[@]}" "$WORK/leaf.pem" >"$WORK/verify.log" 2>&1; then
      fail "Sertifika zinciri dogrulanamadi: $(grep -E 'error|unable|certificate' "$WORK/verify.log" | head -2 | tr '\n' ' ')CA paketini (ara sertifikalari) CA alanina ekleyin."
    fi
  fi

  ISSUER="$(openssl x509 -in "$WORK/leaf.pem" -noout -issuer -nameopt multiline,-esc_msb 2>/dev/null \
    | awk -F' = ' '/organizationName/{o=$2} /commonName/{c=$2} END{print (o!=""?o:c)}')"
  [ -n "$ISSUER" ] || ISSUER="$(openssl x509 -in "$WORK/leaf.pem" -noout -issuer 2>/dev/null | sed 's/^issuer= *//')"
  EXPIRY_ISO="$(cert_expiry_iso "$WORK/leaf.pem")"
  [ -n "$EXPIRY_ISO" ] || fail "Sertifika bitis tarihi okunamadi."

  # --- Kalici dosyalar + canli nginx ---
  install -d -m 0700 "$LE_ROOT/custom" "$CUSTOM_DIR"
  snapshot_confs
  mkdir -p "$WORK/prev"
  for f in cert.pem chain.pem fullchain.pem privkey.pem; do
    [ -f "$CUSTOM_DIR/$f" ] && cp "$CUSTOM_DIR/$f" "$WORK/prev/$f"
  done

  cat "$WORK/leaf.pem" > "$CUSTOM_DIR/cert.pem"
  cat "$WORK/chain.pem" > "$CUSTOM_DIR/chain.pem"
  cat "$WORK/leaf.pem" "$WORK/chain.pem" > "$CUSTOM_DIR/fullchain.pem"
  cat "$WORK/key.pem" > "$CUSTOM_DIR/privkey.pem"
  chmod 600 "$CUSTOM_DIR"/*.pem
  copy_to_proxy "$CUSTOM_DIR"

  if has_live_https; then
    repoint_conf "$DEST_CONF" "$LIVE_DIR" "$CUSTOM_DIR"
    [ -f "$GENERATED_CONF" ] && repoint_conf "$GENERATED_CONF" "$LIVE_DIR" "$CUSTOM_DIR"
  else
    # Henuz HTTPS yok: sablondaki yorumlu HTTPS blogunu ac (ssl-issue.sh ve
    # nginxTemplate.activateHttps ile AYNI kural — ucu birlikte degismeli).
    ACTIVATED="$(sed -n '/--- HTTPS (443, HTTP\/2)/,$p' "$GENERATED_CONF" | tail -n +2 | sed -E 's/^# ?//')"
    [ -n "$ACTIVATED" ] || fail "Sablonda HTTPS blogu bulunamadi — ops/nginx/templates/vhost.conf.tmpl degismis olabilir."
    printf '%s\n' "$ACTIVATED" > "$WORK/new.conf"
    cat "$WORK/new.conf" > "$DEST_CONF"
    cat "$WORK/new.conf" > "$GENERATED_CONF"
    repoint_conf "$DEST_CONF" "$LIVE_DIR" "$CUSTOM_DIR"
    repoint_conf "$GENERATED_CONF" "$LIVE_DIR" "$CUSTOM_DIR"
  fi
  restore_owner "$DEST_OWNER" "$DEST_CONF"
  restore_owner "$GEN_OWNER" "$GENERATED_CONF"

  reload_or_rollback "yeni sertifika"

  # Kullanilan bekleyen CSR/anahtar artik gereksiz.
  rm -f "$CUSTOM_DIR/pending.key" "$CUSTOM_DIR/pending.csr"

  echo "✓ Ozel sertifika $DOMAIN icin kuruldu ($ISSUER)."
  echo "SSL_RESULT domain=$DOMAIN expiry=$EXPIRY_ISO type=custom www=$WWW chain=$CHAIN_STATE key=$KEYSRC issuer=$ISSUER"
}

# --------------------------------------------------------------- info
cmd_info() {
  local pem="" type=""
  if [ -f "$CUSTOM_DIR/cert.pem" ] && [ -f "$DEST_CONF" ] && grep -qF "$CUSTOM_DIR/" "$DEST_CONF"; then
    pem="$CUSTOM_DIR/cert.pem"; type="custom"
  elif [ -f "$LIVE_DIR/cert.pem" ]; then
    pem="$LIVE_DIR/cert.pem"; type="letsencrypt"
  fi
  if [ -z "$pem" ]; then
    echo "present=0"
    [ -f "$CUSTOM_DIR/pending.csr" ] && echo "pending_csr=1" || echo "pending_csr=0"
    return 0
  fi
  echo "present=1"
  echo "type=$type"
  echo "subject=$(openssl x509 -in "$pem" -noout -subject -nameopt oneline,-esc_msb | sed 's/^subject= *//')"
  echo "issuer=$(openssl x509 -in "$pem" -noout -issuer -nameopt oneline,-esc_msb | sed 's/^issuer= *//')"
  echo "serial=$(openssl x509 -in "$pem" -noout -serial | cut -d= -f2)"
  echo "not_before=$(openssl x509 -in "$pem" -noout -startdate -dateopt iso_8601 2>/dev/null | cut -d= -f2 | tr ' ' 'T')"
  echo "not_after=$(cert_expiry_iso "$pem")"
  echo "fingerprint=$(openssl x509 -in "$pem" -noout -fingerprint -sha256 | cut -d= -f2)"
  echo "sans=$(openssl x509 -in "$pem" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ' | tr -d '\n')"
  echo "key_algo=$(openssl x509 -in "$pem" -noout -text | awk -F': ' '/Public Key Algorithm/{print $2; exit}')"
  echo "key_bits=$(openssl x509 -in "$pem" -noout -text | grep -oE 'Public-Key: \([0-9]+ bit\)' | head -1 | grep -oE '[0-9]+')"
  local fc="${pem%cert.pem}fullchain.pem"
  echo "chain_length=$( [ -f "$fc" ] && grep -c 'BEGIN CERTIFICATE' "$fc" || echo 1 )"
  [ -f "$CUSTOM_DIR/pending.csr" ] && echo "pending_csr=1" || echo "pending_csr=0"
}

cmd_pending() {
  [ -f "$CUSTOM_DIR/pending.csr" ] || fail "Bu domain icin bekleyen CSR yok."
  cat "$CUSTOM_DIR/pending.csr"
}

# ------------------------------------------------------------- remove
cmd_remove() {
  [ -d "$CUSTOM_DIR" ] || fail "Bu domain icin ozel sertifika yok."
  command -v docker >/dev/null 2>&1 || fail "docker bulunamadi."

  if [ "$OPT" = "--http-only" ]; then
    # API vhost'u zaten duz HTTP olarak yeniden uretip yayinladi; geriye
    # yalnizca dosyalari silmek kaliyor. Canli conf hala ozel dizini
    # gosteriyorsa silmek nginx'i bozar — reddet.
    if [ -f "$DEST_CONF" ] && grep -qF "$CUSTOM_DIR/" "$DEST_CONF"; then
      fail "Canli vhost hala ozel sertifikayi kullaniyor; once HTTP vhost'u yayinlayin."
    fi
    rm -rf "$CUSTOM_DIR"
    docker exec proxy-server rm -rf "$CUSTOM_DIR" 2>/dev/null || true
    echo "SSL_RESULT domain=$DOMAIN removed=1 fallback=http"
    return 0
  fi

  if [ ! -f "$LIVE_DIR/fullchain.pem" ] || [ ! -f "$LIVE_DIR/privkey.pem" ]; then
    echo "HATA: NO_LE — geri donulecek Let's Encrypt sertifikasi yok." >&2
    exit 3
  fi

  [ -f "$DEST_CONF" ] || fail "nginx config yok: $DEST_CONF"
  snapshot_confs
  copy_to_proxy "$LIVE_DIR"
  repoint_conf "$DEST_CONF" "$CUSTOM_DIR" "$LIVE_DIR"
  [ -f "$GENERATED_CONF" ] && repoint_conf "$GENERATED_CONF" "$CUSTOM_DIR" "$LIVE_DIR"
  restore_owner "$DEST_OWNER" "$DEST_CONF"
  restore_owner "$GEN_OWNER" "$GENERATED_CONF"
  reload_or_rollback "Let's Encrypt'e donus"

  rm -rf "$CUSTOM_DIR"
  docker exec proxy-server rm -rf "$CUSTOM_DIR" 2>/dev/null || true
  EXPIRY_ISO="$(cert_expiry_iso "$LIVE_DIR/cert.pem")"
  echo "✓ Ozel sertifika kaldirildi; $DOMAIN Let's Encrypt sertifikasina dondu."
  echo "SSL_RESULT domain=$DOMAIN removed=1 fallback=letsencrypt expiry=$EXPIRY_ISO"
}

case "$CMD" in
  csr)     cmd_csr ;;
  install) cmd_install ;;
  info)    cmd_info ;;
  pending) cmd_pending ;;
  remove)  cmd_remove ;;
  *) fail "Bilinmeyen komut: $CMD" ;;
esac
