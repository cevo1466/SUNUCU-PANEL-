#!/bin/sh
# ops/scripts/backup-run.sh [domain...]
#
# Zamanlanmis yedekleme. Argumansiz calistirilirsa PANELDEKI TUM domainleri
# yedekler.
#
# NEDEN AYRI SCRIPT (API ucu varken): cron'un HTTP oturumu yoktur ve panelin
# kimlik dogrulamasindan gecemez. Ayrica yedek alma dakikalar surebiliyor;
# bunu bir HTTP istegine baglamak zaman asimina davetiye olurdu.
#
# UST USTE BINME KORUMASI: yedekleme uzun surer ve bir sonraki tur baslarsa
# ayni domain iki kez arsivlenir, disk iki katina cikar. `service.sh ensure`
# ile AYNI atomik mkdir kilidi kullaniliyor.
set -u

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
LOCK="$PROJECT_ROOT/ops/run/.backup.lock"
mkdir -p "$PROJECT_ROOT/ops/run"

# Bayat kilit: bir tur cakilip kilidi birakmamis olabilir. Yedekleme uzun
# surdugu icin sinir genis tutuldu (3 saat).
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin -180 2>/dev/null)" ]; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] bayat yedek kilidi temizlendi"
    rmdir "$LOCK" 2>/dev/null || true
  fi
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] baska bir yedekleme suruyor, atlandi"
  exit 75
fi
# HUP ve PIPE de yakalanir: cikti bir boruya yaziliyorsa borunun ucu kapaninca
# SIGPIPE gelir ve kilit arda kalirdi (ayni ders service.sh'te ogrenildi).
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM HUP PIPE

if [ "$#" -gt 0 ]; then
  DOMAINS="$*"
else
  if ! DOMAINS="$(node ops/scripts/db-query.mjs "SELECT domain_name FROM domains ORDER BY domain_name")"; then
    echo "Domain listesi veritabanından alınamadı; yedekleme başarısız." >&2
    node ops/scripts/notify.mjs "Zamanlanmış yedekleme başarısız" \
      "Domain listesi okunamadı; veritabanı ve ops/backup.log dosyasını kontrol edin." critical || true
    exit 1
  fi
fi

[ -n "$DOMAINS" ] || { echo "Yedeklenecek domain yok."; exit 0; }

FAILED=0
for DOMAIN in $DOMAINS; do
  [ -n "$DOMAIN" ] || continue
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] yedekleniyor: $DOMAIN"
  if node ops/scripts/backup-cli.mjs snapshot "$DOMAIN"; then
    echo "  ✓ $DOMAIN"
  else
    echo "  ✗ $DOMAIN yedeklenemedi" >&2
    FAILED=1
    node ops/scripts/notify.mjs "Yedekleme başarısız: $DOMAIN" \
      "Zamanlanmış yedekleme bu domain için tamamlanamadı. Log: ops/backup.log" critical || true
  fi
done

exit "$FAILED"
