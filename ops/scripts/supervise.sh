#!/bin/sh
# Studio Panel servis gozetmeni.
#
# Neden var: servisler daha once "nohup ... &" ile baslatiliyordu, child
# dusunce kimse ayaga kaldirmiyordu ve panel 502 veriyordu (Oturum 13). Sonra
# screen icinde bir while dongusune tasindi, ama cikti screen'in scrollback
# tamponunda BELLEKTE birikiyordu. Bu script ikisini de cozer: child duserse
# yeniden baslatir VE ciktiyi boyutu sinirli bir dosyaya yazar.
#
# BU SCRIPT DOGRUDAN CAGRILMAZ. Servisleri baslatmak icin:
#   ops/scripts/service.sh start all
#
# ARTIK SCREEN KULLANILMIYOR (Oturum 2026-08-27): gozetmen screen icinde
# calisiyordu, kullanici screen oturumlarini kapatinca api ve web oldu ve
# panel 502 verdi. service.sh bu dongüyü `setsid` ile kendi oturumunda
# baslatir; hicbir terminal/agent oturumuna bagli degildir.

set -u

SERVICE="${1:-}"
PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/ops"
MAX_LOG_BYTES=10485760   # 10 MB
RESTART_DELAY=2

case "$SERVICE" in
  api)
    LOG_FILE="$LOG_DIR/api.log"
    WORK_DIR="$PROJECT_ROOT/apps/api"
    START_CMD="node dist/server.js"
    # Yalnizca uyari ve hatalar yazilsin.
    #
    # DIKKAT: burada NODE_ENV=production KULLANILMAZ. Oturum cerezi
    # `secure: NODE_ENV === "production"` ile isaretleniyor; panel su an duz
    # HTTP uzerinden (203.0.113.10) sunuldugu icin Secure cerez tarayiciya hic
    # ulasmaz ve GIRIS TAMAMEN BOZULUR. Log seviyesi bu yuzden ayri bir
    # degiskenle veriliyor. HTTPS'e gecildiginde NODE_ENV=production dogru
    # olur ve bu satir kaldirilabilir.
    export LOG_LEVEL="${LOG_LEVEL:-warn}"
    ;;
  web)
    LOG_FILE="$LOG_DIR/web.log"
    WORK_DIR="$PROJECT_ROOT"
    START_CMD="npm run start --workspace=apps/web"
    ;;
  mariadb)
    # MySQL/MariaDB veritabanı motoru için (bkz. apps/api/src/lib/databases.ts
    # mysqlConnection). /var/lib/mysql "mysql" sistem kullanıcısına ait
    # olduğundan devuser doğrudan başlatamaz — dar kapsamlı sudo ile
    # mysqld_safe çağrılır (bkz. PROD-DEPLOYMENT.md §1).
    LOG_FILE="$LOG_DIR/mariadb.log"
    # /var/lib/mysql "mysql" kullanıcısına ait, devuser oraya cd edemez —
    # supervise.sh'in kendi cd'si bu yüzden proje köküne yapılır.
    WORK_DIR="$PROJECT_ROOT"
    START_CMD="sudo /usr/bin/mysqld_safe --user=mysql --datadir=/var/lib/mysql --bind-address=127.0.0.1"
    ;;
  adminer)
    # Tek dosyalık adminer.php'yi PHP'nin kendi geliştirme sunucusuyla
    # 127.0.0.1'de sunar — ayrı bir nginx/php-fpm yapılandırması gerekmez.
    # Repoda takip edilen adminer-entry.php, bos giris formunu panelin gercek
    # PostgreSQL adresiyle (127.0.0.1:5433) acar. Vendor adminer.php'yi
    # dogrudan router yapmak yeniden "localhost:5432" hatasini uretir.
    # Kurulum: ops/scripts/install-adminer.sh (bkz. PROD-DEPLOYMENT.md §2b).
    LOG_FILE="$LOG_DIR/adminer.log"
    WORK_DIR="$PROJECT_ROOT/ops/adminer"
    # Hangi PHP CLI binary'siyle çalışacağı panelden seçilebilir (bkz.
    # apps/api/src/lib/adminer.ts setAdminerPhpBin).
    #
    # Seçim KALICI ayar dosyasından okunur, yalnızca ortam değişkeninden
    # DEĞİL: crond watchdog'u (service.sh ensure) Adminer'ı panelden bağımsız
    # olarak yeniden başlatabiliyor ve o çağrıda ADMINER_PHP_BIN yok. Sadece
    # env'e bakılsaydı, watchdog bir kez devreye girdiğinde panelden seçilen
    # sürüm sessizce PATH'teki varsayılan "php"ye düşerdi — ve seçili sürümde
    # kurulu olan veritabanı sürücüleri kaybolduğu için Adminer girişleri
    # yeniden bozulurdu.
    # Öncelik: ortam değişkeni > ayar dosyası > "php".
    ADMINER_SETTINGS="$PROJECT_ROOT/ops/generated/adminer-settings.json"
    ADMINER_BIN="${ADMINER_PHP_BIN:-}"
    if [ -z "$ADMINER_BIN" ] && [ -f "$ADMINER_SETTINGS" ]; then
      ADMINER_BIN=$(sed -n 's/.*"php_bin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ADMINER_SETTINGS")
    fi
    [ -n "$ADMINER_BIN" ] || ADMINER_BIN=php
    START_CMD="$ADMINER_BIN -S 127.0.0.1:${ADMINER_PORT:-8098} $PROJECT_ROOT/ops/scripts/adminer-entry.php"
    ;;
  *)
    echo "Kullanim: $0 {api|web|adminer|mariadb}" >&2
    exit 2
    ;;
esac

# Basit boyut siniri. logrotate bu konteynerde yok; her yeniden baslatmada ve
# turda kontrol edilir. Tek bir .1 kusagi tutuluyor — panel loglari adli tip
# kaydi degil, son duruma bakmak icin.
rotate_if_large() {
  if [ -f "$LOG_FILE" ]; then
    size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
      mv -f "$LOG_FILE" "$LOG_FILE.1"
      : > "$LOG_FILE"
    fi
  fi
}

cd "$WORK_DIR" || exit 1

# Gozetmenin kendi PID'ini service.sh'in okuyacagi dosyaya yazar. service.sh
# `setsid ... &` ile baslattigi icin kendi $! degeri gecici setsid surecine
# aitti ve hemen olurdu; tek guvenilir kaynak gozetmenin kendi $$ degeri.
if [ -n "${SUPERVISOR_PIDFILE:-}" ]; then
  echo "$$" > "$SUPERVISOR_PIDFILE"
  # Gozetmen kapanirken pidfile'i birakma — bayat pidfile watchdog'a
  # "calisiyor" yalani soyler.
  # Kendi PID'ine degil child'a sinyal gonderilir: `kill -TERM -$$` tum
  # surec grubunu (kendimiz dahil) hedefler ve trap'i yeniden tetikleyerek
  # donguye girer. service.sh zaten grubu TERM'liyor; burada sadece calisan
  # child kapatilir ve pidfile temizlenir.
  trap 'rm -f "$SUPERVISOR_PIDFILE"; [ -n "${child:-}" ] && kill -TERM "$child" 2>/dev/null; exit 0' TERM INT
fi

while true; do
  rotate_if_large
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $SERVICE baslatiliyor" >> "$LOG_FILE"

  # Cikti dosyaya gider; bellekte log birikmez.
  # Arka planda calistirilip `wait` edilir: boylece TERM geldiginde trap
  # hemen isler ve child'in PID'i bilinir (onplanda calissa trap child
  # bitene kadar beklerdi).
  $START_CMD >> "$LOG_FILE" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=""

  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $SERVICE durdu (kod=$code), ${RESTART_DELAY}sn sonra yeniden" >> "$LOG_FILE"
  sleep "$RESTART_DELAY"
done
