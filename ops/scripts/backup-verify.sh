#!/bin/sh
# ops/scripts/backup-verify.sh [domain...]
#
# Zamanlanmis GERI YUKLEME TESTI. Her domainin EN SON yedegini gecici bir
# alana acar, sha256'lari karsilastirir ve SQL dokumlerini gecici bir
# veritabanina GERCEKTEN yukler.
#
# NEDEN VAR: bir yedegin diskte durmasi hicbir sey kanitlamaz. Panel bir
# yedegi ancak bu test gectiyse "geri yuklenebilir" diye gosterir; denenmemis
# yedek "dogrulanmadi" olarak kalir. Test canli veriye DOKUNMAZ.
set -u

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
LOCK="$PROJECT_ROOT/ops/run/.backup-verify.lock"
mkdir -p "$PROJECT_ROOT/ops/run"

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin -180 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
  fi
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] baska bir dogrulama suruyor, atlandi"
  exit 75
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM HUP PIPE

if [ "$#" -gt 0 ]; then
  DOMAINS="$*"
else
  if ! DOMAINS="$(node ops/scripts/db-query.mjs "SELECT domain_name FROM domains ORDER BY domain_name")"; then
    echo "Domain listesi veritabanından alınamadı; yedek doğrulaması başarısız." >&2
    node ops/scripts/notify.mjs "Yedek doğrulaması başarısız" \
      "Domain listesi okunamadı; veritabanı ve ops/backup.log dosyasını kontrol edin." critical || true
    exit 1
  fi
fi

FAILED=0
for DOMAIN in $DOMAINS; do
  [ -n "$DOMAIN" ] || continue
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] dogrulaniyor: $DOMAIN"
  if node ops/scripts/backup-cli.mjs verify "$DOMAIN"; then
    echo "  ✓ $DOMAIN"
  else
    echo "  ✗ $DOMAIN dogrulamasi BASARISIZ" >&2
    FAILED=1
    node ops/scripts/notify.mjs "Yedek doğrulaması BAŞARISIZ: $DOMAIN" \
      "Bu domainin en son yedeği geri yükleme testinden geçemedi. Yedek bozuk olabilir; panelden kontrol edin." critical || true
  fi
done

exit "$FAILED"
