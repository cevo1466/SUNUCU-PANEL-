#!/bin/sh
# Studio Panel — calisan panele karsi uctan uca API denetimi.
#
# Self-test'ten farki: bu script CANLI surece, gercek Nginx/Next.js/Fastify
# zincirinin ucundan konusur. Amac "kod derleniyor mu" degil, "kullanici
# tarayicidan bu ucu kullanabiliyor mu" sorusunu yanitlamak.
#
# Kullanim:
#   ops/scripts/api-smoke.sh                      # http://127.0.0.1:3000 uzerinden
#   BASE=http://203.0.113.10 ops/scripts/api-smoke.sh
#
# Parola .env.loopkit'ten okunmaz; PANEL_PASSWORD ile verilir. Verilmezse
# yalnizca oturum GEREKTIRMEYEN kontroller calisir ve digerleri "atlandi"
# olarak raporlanir — sahte "gecti" yazilmaz.

set -u

BASE="${BASE:-http://127.0.0.1:3000}"
JAR="$(mktemp)"
PASS=0
FAIL=0
SKIP=0

trap 'rm -f "$JAR"' EXIT

# $1 etiket, $2 beklenen kod (virgulle birden fazla olabilir), $3.. curl argumanlari
check() {
  label="$1"
  expected="$2"
  shift 2

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" "$@" 2>/dev/null)

  if echo ",$expected," | grep -q ",$code,"; then
    printf '  \033[32mGECTI\033[0m   %-42s %s\n' "$label" "$code"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mKALDI\033[0m   %-42s %s (beklenen: %s)\n' "$label" "$code" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  printf '  \033[33mATLANDI\033[0m %-42s %s\n' "$1" "$2"
  SKIP=$((SKIP + 1))
}

echo "Studio Panel API denetimi — $BASE"
echo

echo "Oturum gerektirmeyenler"
check "GET  /api/health"                    200,503 "$BASE/api/health"
# Oturumsuz veri uclari 401 DONMELI. 200 donerse yetkilendirme delinmis demektir.
check "GET  /api/domains (oturumsuz)"       401     "$BASE/api/domains"
check "GET  /api/metrics/resources (ots.)"  401     "$BASE/api/metrics/resources"
check "GET  /api/databases/engines (ots.)"  401     "$BASE/api/databases/engines"
# Tarayicidan koke gidildiginde login'e yonlendirilmeli, panel HTML'i DONMEMELI.
check "GET  / (oturumsuz -> /login)"        307,308 "$BASE/"
check "GET  /login"                         200     "$BASE/login"

echo
echo "Oturum gerektirenler"

if [ -z "${PANEL_PASSWORD:-}" ] || [ -z "${PANEL_EMAIL:-}" ]; then
  skip "giris"                              "PANEL_EMAIL / PANEL_PASSWORD verilmedi"
  skip "GET  /api/auth/me"                  "oturum yok"
  skip "GET  /api/domains"                  "oturum yok"
  skip "GET  /api/metrics/resources"        "oturum yok"
  skip "GET  /api/metrics/history"          "oturum yok"
  skip "GET  /api/metrics/uptime"           "oturum yok"
  skip "GET  /api/databases/engines"        "oturum yok"
  skip "domain bagimli uclar"               "oturum yok"
else
  check "POST /api/auth/login"              200 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$PANEL_EMAIL\",\"password\":\"$PANEL_PASSWORD\"}" \
    "$BASE/api/auth/login"

  check "GET  /api/auth/me"                 200 "$BASE/api/auth/me"
  check "GET  /api/domains"                 200 "$BASE/api/domains"
  check "GET  /api/metrics/resources"       200 "$BASE/api/metrics/resources"
  check "GET  /api/metrics/history?range=30m" 200 "$BASE/api/metrics/history?range=30m"
  # HetrixTools yapilandirilmamissa 200 + not_configured doner; yukaridayken 502.
  check "GET  /api/metrics/uptime"          200,502 "$BASE/api/metrics/uptime"
  check "GET  /api/databases/engines"       200 "$BASE/api/databases/engines"

  # Ilk domainin alt uclari. Domain yoksa bu blok atlanir.
  DOMAIN_ID=$(curl -s -b "$JAR" "$BASE/api/domains" \
    | sed -n 's/.*"domains":\[{"id":\([0-9]*\).*/\1/p')

  if [ -n "$DOMAIN_ID" ]; then
    echo "  (domain #$DOMAIN_ID uzerinden)"
    check "GET  /api/domains/:id/files"     200 "$BASE/api/domains/$DOMAIN_ID/files?path="
    check "GET  /api/domains/:id/dns"       200 "$BASE/api/domains/$DOMAIN_ID/dns"
    check "GET  /api/domains/:id/ssl"       200 "$BASE/api/domains/$DOMAIN_ID/ssl"
    check "GET  /api/domains/:id/ftp"       200 "$BASE/api/domains/$DOMAIN_ID/ftp"
    check "GET  /api/domains/:id/databases" 200 "$BASE/api/domains/$DOMAIN_ID/databases"
    check "GET  /api/domains/:id/backups"   200 "$BASE/api/domains/$DOMAIN_ID/backups"
    # Baska bir kullanicinin domaini gibi davranan olmayan id: 404 DONMELI.
    check "GET  /api/domains/999999 (yok)"  404 "$BASE/api/domains/999999"
  else
    skip "domain bagimli uclar"             "panelde hic domain yok"
  fi

  check "POST /api/auth/logout"             200 -X POST "$BASE/api/auth/logout"
fi

echo
printf 'Sonuc: %d gecti, %d kaldi, %d atlandi\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
