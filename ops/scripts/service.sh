#!/bin/sh
# Studio Panel servis yoneticisi — SCREEN KULLANMAZ.
#
# NEDEN VAR (kok neden, Oturum 2026-08-27):
#   Servisler `screen -dmS studio-panel-api ops/scripts/supervise.sh api`
#   seklinde screen oturumlari icinde calisiyordu. Kullanici bakim icin
#   screen oturumlarini kapatinca api (3001) ve web (3000) surecleri de
#   oldu; dis nginx konteyneri upstream'e ulasamayip 502 Bad Gateway
#   dondurdu. Yani panelin ayakta kalmasi bir terminal oturumunun omrune
#   bagliydi — kirilgan ve gorunmez bir bagimlilik.
#
# COZUM: gozetmen dongusu `setsid` ile KENDI oturumunda (session leader)
# baslatilir. Boylece:
#   - baslatan kabuk/agent/screen kapansa bile surec yasar (SIGHUP almaz),
#   - child duserse supervise.sh onu yeniden ayaga kaldirir,
#   - supervise.sh'in kendisi olurse (OOM kill) crond watchdog'u
#     (`service.sh ensure`, dakikada bir) onu yeniden baslatir.
#
# KONTEYNER YENIDEN BASLADIYSA bu script yetmez: crond dahil hicbir sey
# otomatik baslamaz. Tek komut icin ops/scripts/boot.sh kullanin.
#
# Kullanim:
#   ops/scripts/service.sh start   [api|web|adminer|postgres|mariadb|all]
#   ops/scripts/service.sh stop    [api|web|adminer|all]   # veritabanlarini durdurmaz
#   ops/scripts/service.sh restart [api|web|adminer|all]
#   ops/scripts/service.sh status                          # veritabanlarini da gosterir
#   ops/scripts/service.sh ensure          # watchdog: duseni kaldir (db dahil)
#   ops/scripts/service.sh maintenance-on   # watchdog'u gecici durdur (derleme)
#   ops/scripts/service.sh maintenance-off
#   ops/scripts/service.sh install-watchdog # crond kaydini yaz
set -u

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
if [ -f "$PROJECT_ROOT/.env.loopkit" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PROJECT_ROOT/.env.loopkit"
  set +a
fi
RUN_DIR="$PROJECT_ROOT/ops/run"
SUPERVISOR="$PROJECT_ROOT/ops/scripts/supervise.sh"
ALL_SERVICES="api web adminer"

# Veritabanlari: supervise.sh ile YONETILMEZ, ayri ele alinir.
#
# NEDEN AYRI (kok neden, Oturum 2026-08-31): kullanici diski 50→100 GB
# buyutmek icin Docker'i durdurdu. Konteyner geri geldiginde PID 1 yalnizca
# dockerd; panelin hicbir sureci — crond dahil — otomatik baslamadi.
# PostgreSQL de dusmustu ve HICBIR watchdog kapsaminda degildi, bu yuzden
# crond elle kaldirildiginda bile api "ECONNREFUSED 127.0.0.1:5433" ile
# dususe giriyordu. Artik `ensure` veritabanlarini da ayaga kaldiriyor.
#
# NEDEN supervise.sh DEGIL: her ikisi de kendini daemonize eder (pg_ctl,
# mysqld_safe) — supervise.sh'in bekledigi on-planda kalan surec yoktur.
# Daha onemlisi start_one → reap_orphans portu tutani SIGKILL ile oldurur;
# bir veritabanina KILL gondermek veri bozulmasi riskidir. Bu yuzden asagidaki
# akis yalnizca "port bos ise baslat" yapar, asla oldurmez.
DB_SERVICES="postgres mariadb"

# PHP-FPM: musteri sitelerinin PHP calistiricisi.
#
# `all` KAPSAMI DISI: restart-services.sh panel derlemesi icin `stop all`
# cagiriyor ve bir panel derlemesinin musteri sitelerini durdurmasi kabul
# edilemez. DB'ler gibi kendini daemonize eder, bu yuzden supervise.sh degil
# port kontrolu ile yonetilir. DB'lerden FARKI: durdurmak/yeniden baslatmak
# guvenlidir (veri bozulmasi riski yok), o yuzden refuse_db_command kapsamina
# GIRMEZ.
#
# 2026-09-01'de bulundu: paket hic kurulu degildi, panel PHP runtime'ini
# sunuyor ama arkasinda hicbir sey yoktu — her PHP istegi 502 veriyordu.
PHP_FPM_SERVICE="php-fpm"
PHP_FPM_PORT=9000
PHP_FPM_BIN="/usr/sbin/php-fpm84"

mkdir -p "$RUN_DIR"

pidfile() { echo "$RUN_DIR/$1.pid"; }

# Bakim kilidi.
#
# NEDEN VAR: watchdog dakikada bir `ensure` calistiriyor. `next build` bir
# dakikadan uzun suruyor ve restart-services.sh derleme icin web'i
# durdurdugunda watchdog onu derlemenin ORTASINDA yeniden baslatiyordu; iki
# surec ayni .next dizinini yazip silince derleme
# "ENOENT: .next/server/pages-manifest.json" ile duser. (Gercekten yasandi.)
#
# Kilit dosyasi varken `ensure` hicbir sey yapmaz. Kilidin bir de yas siniri
# var: derleme yarida cokerse watchdog sonsuza kadar devre disi kalmasin.
MAINT_LOCK="$RUN_DIR/.maintenance"
MAINT_MAX_AGE_SEC=1800

maintenance_active() {
  [ -f "$MAINT_LOCK" ] || return 1
  started="$(cat "$MAINT_LOCK" 2>/dev/null || echo 0)"
  now="$(date -u +%s)"
  age=$((now - started))
  if [ "$age" -gt "$MAINT_MAX_AGE_SEC" ]; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] bakim kilidi ${age}sn'dir duruyor, yok sayiliyor"
    rm -f "$MAINT_LOCK"
    return 1
  fi
  return 0
}

# Servisin gercekten hizmet verdigi TCP portu. Saglik kontrolu pid'e degil
# porta bakar: surec ayakta ama dinlemiyorsa da "calismiyor" demektir.
port_of() {
  case "$1" in
    api) echo 3001 ;;
    web) echo 3000 ;;
    adminer) echo "${ADMINER_PORT:-8098}" ;;
    *) echo "" ;;
  esac
}

health_path() {
  case "$1" in
    api) echo "/api/health" ;;
    web) echo "/login" ;;
    adminer) echo "/" ;;
    *) echo "/" ;;
  esac
}

# PID gercekten BIZIM gozetmenimiz mi? Sadece /proc/<pid> varligina bakmak
# yetmez — PID yeniden kullanilmis olabilir, o zaman olu servisi "calisiyor"
# sayardik. cmdline icinde supervise.sh ve servis adi da aranir.
supervisor_alive() {
  svc="$1"
  pf="$(pidfile "$svc")"
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null)"
  [ -n "${pid:-}" ] || return 1
  [ -d "/proc/$pid" ] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  case "$cmd" in
    *supervise.sh*" $svc"*) return 0 ;;
    *) return 1 ;;
  esac
}

port_healthy() {
  svc="$1"
  port="$(port_of "$svc")"
  [ -n "$port" ] || return 0
  # DIKKAT — `|| echo 000` KULLANMA. curl baglanti kuramadiginda
  # `-w '%{http_code}'` zaten "000" YAZAR ve ayrica 7 ile cikar; `|| echo 000`
  # ikinci bir "000" ekleyip degiskeni "000000" yapar. Asagidaki case bunu
  # tanimaz, `*)` dalina duser ve OLU SERVISI SAGLIKLI RAPOR EDER.
  # (2026-08-31: konteyner yeniden basladiktan sonra api/web/adminer'in ucu de
  # olmusken `service.sh status` uctinu de "port ✓" gosterdi; panel 502
  # verirken durum ciktisi her sey yolunda diyordu.)
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port$(health_path "$svc")" 2>/dev/null)"
  [ -n "$code" ] || code=000
  case "$code" in
    000|502|503|504) return 1 ;;
    *) return 0 ;;
  esac
}

start_one() {
  svc="$1"
  if supervisor_alive "$svc"; then
    echo "• $svc zaten calisiyor (pid $(cat "$(pidfile "$svc")"))"
    return 0
  fi
  # Ayni servisin sahipsiz kalmis eski child'lari varsa portu tutuyor olabilir.
  # Temizlenemezse BASLATMA: yeni surec EADDRINUSE ile dususe girer, saglik
  # kontrolu ise portu tutan ESKI surece 200 alip deploy'u basarili sanardi.
  if ! reap_orphans "$svc"; then
    echo "  ! $svc baslatilmadi — portu baska bir surec tutuyor, once onu temizleyin." >&2
    return 1
  fi
  echo "» $svc baslatiliyor"
  # setsid: yeni oturum → baslatan kabuk kapanınca SIGHUP gelmez.
  # Pidfile'i supervise.sh kendisi yazar (bkz. supervise.sh SUPERVISOR_PIDFILE).
  SUPERVISOR_PIDFILE="$(pidfile "$svc")" \
    setsid "$SUPERVISOR" "$svc" </dev/null >>"$RUN_DIR/$svc.boot.log" 2>&1 &
  # Pidfile'in yazilmasini bekle (en fazla 5 sn).
  i=0
  while [ "$i" -lt 50 ]; do
    supervisor_alive "$svc" && return 0
    i=$((i + 1))
    sleep 0.1 2>/dev/null || sleep 1
  done
  echo "  ! $svc gozetmeni pidfile yazmadi, $RUN_DIR/$svc.boot.log dosyasina bak" >&2
  return 1
}

# Gozetmen olmadan kalmis child surecler. Portu tuttuklari icin yeni
# gozetmenin child'i EADDRINUSE ile dusup duruyordu.
#
# KOMUT SATIRI KALIBIYLA DEGIL, PORT SAHIPLIGIYLE hedeflenir. Onceki surum
# `pkill -f next-server` kullaniyordu; bu, komut satirinda o metni gecen
# HERHANGI bir sureci oldurur:
#   - bu panel musteri uygulamalarini barindiriyor; `next-server` calistiran
#     bir musteri sitesi, panelin kendi servis restart'inda olurdu,
#   - kalibi komut satirinda tasiyan cagiran kabuk de kendini olduruyordu
#     (bu oturumda gercekten yasandi).
# Portu kim dinliyorsa sahibi odur; tek dogru hedef budur.
# Portu dinleyen PID'ler. netstat, BASKA BIR KULLANICININ soketinde PID
# sutununu "-" olarak gosterir ("showing only processes with your user ID").
# Bu yuzden root olarak baslatilmis bir eski servis devuser'a GORUNMEZ kalir;
# reap_orphans onu bulamaz, yeni surec EADDRINUSE ile dususe girer ve saglik
# kontrolu ESKI surece 200 alip "basarili" der — deploy sessizce eski kodu
# servis etmeye devam eder (2026-08-29'da tam olarak bu yasandi: 7 saatlik
# root api sureci, dosya yoneticisi degisiklikleri hic canliya cikmadi).
# Cozum: PID gorunmuyorsa sudo ile tekrar bak.
listeners_on_port() {
  port="$1"
  pids="$(netstat -tlnp 2>/dev/null \
    | awk -v p=":$port\$" '$4 ~ p {split($7,a,"/"); if (a[1] != "" && a[1] != "-") print a[1]}' \
    | sort -u)"
  if [ -z "$pids" ] && port_listening "$port" && sudo -n true 2>/dev/null; then
    pids="$(sudo -n netstat -tlnp 2>/dev/null \
      | awk -v p=":$port\$" '$4 ~ p {split($7,a,"/"); if (a[1] != "" && a[1] != "-") print a[1]}' \
      | sort -u)"
  fi
  echo "$pids"
}

port_listening() {
  netstat -tln 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {found=1} END {exit !found}'
}

reap_orphans() {
  port="$(port_of "$1")"
  [ -n "$port" ] || return 0
  for pid in $(listeners_on_port "$port"); do
    [ "$pid" = "$$" ] && continue
    # Surec grubunu da al: `npm run start` sarmalayicisi child'ini birakmasin.
    pgid="$(awk '{print $5}' "/proc/$pid/stat" 2>/dev/null || sudo -n awk '{print $5}' "/proc/$pid/stat" 2>/dev/null)"
    if [ -n "${pgid:-}" ] && [ "$pgid" != "$$" ]; then
      kill -KILL "-$pgid" 2>/dev/null || sudo -n kill -KILL "-$pgid" 2>/dev/null
    fi
    kill -KILL "$pid" 2>/dev/null || sudo -n kill -KILL "$pid" 2>/dev/null
  done

  # Port hala baskasinin elindeyse SESSIZ GECME: yeni surec dusecek ve
  # saglik kontrolu eski surece bakip yanilacak.
  if port_listening "$port"; then
    echo "  ! $1: port $port hala dolu — sahibi oldurulemedi (baska kullanici?)." >&2
    echo "    'sudo netstat -tlnp | grep :$port' ile bakip elle temizleyin." >&2
    return 1
  fi
  return 0
}

stop_one() {
  svc="$1"
  pf="$(pidfile "$svc")"
  if supervisor_alive "$svc"; then
    pid="$(cat "$pf")"
    echo "» $svc durduruluyor (pid $pid)"
    # Once tum oturum grubunu (gozetmen + child) hedefle: setsid ile
    # baslatildigi icin pgid == pid.
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 30 ] && [ -d "/proc/$pid" ]; do
      i=$((i + 1))
      sleep 0.2 2>/dev/null || sleep 1
    done
    [ -d "/proc/$pid" ] && kill -KILL "-$pid" 2>/dev/null
  fi
  rm -f "$pf"
  # Durdurmada uyari yeter; hata kodu restart akisini yarida kesmesin
  # (asil kapi start_one'da).
  reap_orphans "$svc" || true
}

status_one() {
  svc="$1"
  if supervisor_alive "$svc"; then sup="gozetmen ✓ (pid $(cat "$(pidfile "$svc")"))"; else sup="gozetmen ✗"; fi
  if port_healthy "$svc"; then health="port $(port_of "$svc") ✓"; else health="port $(port_of "$svc") ✗"; fi
  printf '%-9s %-28s %s\n' "$svc" "$sup" "$health"
}

# --- Veritabanlari (bkz. DB_SERVICES basligi) ---------------------------------

db_port_of() {
  case "$1" in
    postgres) echo 5433 ;;
    mariadb) echo 3306 ;;
    *) echo "" ;;
  esac
}

db_running() { port_listening "$(db_port_of "$1")"; }

# Yalnizca baslatir. Zaten calisiyorsa dokunmaz, hicbir kosulda oldurmez.
db_start_one() {
  svc="$1"
  if db_running "$svc"; then
    echo "• $svc zaten calisiyor (port $(db_port_of "$svc"))"
    return 0
  fi
  echo "» $svc baslatiliyor"
  case "$svc" in
    postgres)
      # startPostgres() kendi icinde idempotent: pg_ctl status ile bakar,
      # geride kalmis postmaster.pid'i tanir, gerekirse initdb eder.
      (cd "$PROJECT_ROOT" && npm run --silent db:start) >>"$RUN_DIR/postgres.boot.log" 2>&1
      ;;
    mariadb)
      # /var/lib/mysql "mysql" kullanicisina ait; devuser dogrudan
      # baslatamaz (bkz. supervise.sh mariadb dali, PROD-DEPLOYMENT.md §1).
      # setsid: cagiran kabuk kapaninca SIGHUP ile olmesin.
      setsid sudo -n /usr/bin/mysqld_safe --user=mysql --datadir=/var/lib/mysql \
        --bind-address=127.0.0.1 --skip-networking=0 --port=3306 \
        </dev/null >>"$PROJECT_ROOT/ops/mariadb.log" 2>&1 &
      ;;
  esac
  # Acilis birkac saniye surer; portu bekle.
  i=0
  while [ "$i" -lt 60 ]; do
    db_running "$svc" && return 0
    i=$((i + 1))
    sleep 0.5 2>/dev/null || sleep 1
  done
  echo "  ! $svc portu $(db_port_of "$svc") 30sn'de acilmadi" >&2
  return 1
}

db_status_one() {
  svc="$1"
  if db_running "$svc"; then state="calisiyor ✓"; else state="calismiyor ✗"; fi
  printf '%-9s %-28s %s\n' "$svc" "(supervise.sh disi)" "port $(db_port_of "$svc") $state"
}

# --- PHP-FPM ------------------------------------------------------------------
is_php_fpm() { [ "$1" = "$PHP_FPM_SERVICE" ]; }
php_fpm_running() { port_listening "$PHP_FPM_PORT"; }

php_fpm_start() {
  if php_fpm_running; then
    echo "• $PHP_FPM_SERVICE zaten calisiyor (port $PHP_FPM_PORT)"
    return 0
  fi
  if [ ! -x "$PHP_FPM_BIN" ]; then
    echo "  ! $PHP_FPM_BIN yok — 'sudo apk add php84-fpm' gerekli." >&2
    return 1
  fi
  echo "» $PHP_FPM_SERVICE baslatiliyor"
  # php-fpm kendini daemonize eder; root gerekir cunku havuz devuser olarak
  # calisiyor ve kopru adresine baglaniyor.
  sudo -n "$PHP_FPM_BIN" --fpm-config /etc/php84/php-fpm.conf 2>&1 | tail -3
  i=0
  while [ "$i" -lt 20 ]; do
    php_fpm_running && return 0
    i=$((i + 1))
    sleep 0.5 2>/dev/null || sleep 1
  done
  echo "  ! $PHP_FPM_SERVICE portu $PHP_FPM_PORT acilmadi" >&2
  return 1
}

php_fpm_stop() {
  if ! php_fpm_running; then
    echo "• $PHP_FPM_SERVICE zaten durmus"
    return 0
  fi
  # QUIT = zarif kapanis: calisan istekler bitirilir. FastCGI istegini
  # ortasinda kesmek ziyaretciye yarim sayfa dondururdu.
  sudo -n pkill -QUIT -f "php-fpm: master" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    php_fpm_running || { echo "✓ $PHP_FPM_SERVICE durduruldu"; return 0; }
    i=$((i + 1))
    sleep 0.5 2>/dev/null || sleep 1
  done
  echo "  ! $PHP_FPM_SERVICE durmadi" >&2
  return 1
}

php_fpm_status() {
  if php_fpm_running; then state="calisiyor ✓"; else state="calismiyor ✗"; fi
  printf '%-9s %-28s %s\n' "$PHP_FPM_SERVICE" "(supervise.sh disi)" "port $PHP_FPM_PORT $state"
}

expand() {
  case "${1:-all}" in
    all|"") echo "$ALL_SERVICES" ;;
    *) echo "$1" ;;
  esac
}

CMD="${1:-status}"
TARGET="${2:-all}"

# Veritabanlari `all` kapsamina dahil DEGIL: `restart-services.sh` derleme
# icin `stop all` cagiriyor ve bir derlemenin veritabanini kapatmasi istenmez.
# Yalnizca adiyla (`service.sh start postgres`) veya `ensure` ile yonetilirler.
is_db_service() {
  case " $DB_SERVICES " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# Veritabanini durdurmak/yeniden baslatmak bu script'in ISI DEGIL — ama
# reddederken BASARILI DONMEZ.
#
# NEDEN (gercek kusur, 2026-08-31): ilk surumde `restart postgres` "zaten
# calisiyor" deyip 0 donuyordu. Operator veritabanini yeniden baslattigini
# saniyordu; surec PID'i degismiyordu. `stop postgres` de 0 donuyordu, yani
# `service.sh stop postgres && sonraki_adim` zinciri veritabani durmus gibi
# devam ederdi. Bu, dosyanin basliginda iki kez anlatilan "sessiz sahte
# basari" tuzaginin ta kendisi.
#
# Script gracefully durdurmayi KENDI YAPMIYOR cunku bunu dogru yapmak
# postgres icin `pg_ctl -m fast`, mariadb icin kimlik bilgisi gerektiren
# `mysqladmin shutdown` demek; ikisi de canli panelin veritabani baglantilarini
# koparir ve operatorun bilincli karari olmali. Dogru davranis: yapmadigini
# soyle, nasil yapilacagini goster, sifir DISI don.
refuse_db_command() {
  action="$1"; svc="$2"
  echo "  ! $svc '$action' bu script ile yapilmaz (veri guvenligi)." >&2
  case "$svc" in
    postgres)
      echo "    durdur : npm run db:stop" >&2
      echo "    baslat : $0 start postgres" >&2
      ;;
    mariadb)
      echo "    durdur : sudo mysqladmin -u root -p shutdown" >&2
      echo "    baslat : $0 start mariadb" >&2
      ;;
  esac
  return 2
}

case "$CMD" in
  start)   for s in $(expand "$TARGET"); do
             if is_db_service "$s"; then db_start_one "$s"
             elif is_php_fpm "$s"; then php_fpm_start
             else start_one "$s"; fi
           done ;;
  stop)    rc=0
           for s in $(expand "$TARGET"); do
             # Veritabanini durdurmak acik bir istek olmali; `stop all` ile
             # yanlislikla kapanmaz (yukarida `all` kapsami disinda tutuldu).
             if is_php_fpm "$s"; then
               php_fpm_stop || rc=$?
             elif is_db_service "$s"; then
               refuse_db_command stop "$s" || rc=$?
             else
               stop_one "$s"
             fi
           done
           exit "$rc" ;;
  restart) rc=0
           for s in $(expand "$TARGET"); do
             # Veritabani icin `restart` DUSMEZ ve SESSIZ GECMEZ: yapmadigini
             # soyleyip sifir disi doner (bkz. refuse_db_command).
             if is_php_fpm "$s"; then
               php_fpm_stop && php_fpm_start || rc=$?
             elif is_db_service "$s"; then
               refuse_db_command restart "$s" || rc=$?
             else
               stop_one "$s"; start_one "$s"
             fi
           done
           exit "$rc" ;;
  status)  for s in $(expand "$TARGET"); do
             if is_db_service "$s"; then db_status_one "$s"
             elif is_php_fpm "$s"; then php_fpm_status
             else status_one "$s"; fi
           done
           # Veritabanlari `all` kapsaminda degil ama durumu her zaman
           # gorunmeli: 502'nin kaynagi cogu kez api degil, altindaki
           # PostgreSQL oluyor.
           if [ "$TARGET" = "all" ]; then
             for s in $DB_SERVICES; do db_status_one "$s"; done
             php_fpm_status
           fi ;;
  maintenance-on)
    date -u +%s > "$MAINT_LOCK"
    echo "✓ Bakim modu acik — watchdog mudahale etmeyecek"
    ;;
  maintenance-off)
    rm -f "$MAINT_LOCK"
    echo "✓ Bakim modu kapali"
    ;;
  ensure)
    # Watchdog. Sessiz calisir; yalnizca gercekten mudahale ederse yazar,
    # cunku dakikada bir cron'dan cagriliyor ve log sismesin.
    #
    # ATLANDIGINDA 0 DONMEZ — cikis kodu ENSURE_SKIPPED (75) olur.
    #
    # NEDEN (gercek kusur, 2026-08-31): bakim kilidi veya es zamanli bir tur
    # yuzunden atlandiginda `exit 0` deniyordu. Cron icin bu dogru (atlamak
    # hata degil) ama boot.sh `"$SERVICE" ensure || fail=1` ile cagiriyor:
    # 0 gorunce "servisleri kaldirdim" sayiyordu, oysa HICBIR SEY yapilmamisti.
    # Ayri bir kod ikisini ayirir: cron kodu zaten yok sayar, boot.sh tekrar
    # dener. 75, EX_TEMPFAIL — "gecici, tekrar dene" anlamiyla ortuşuyor.
    ENSURE_SKIPPED=75
    if maintenance_active; then
      exit "$ENSURE_SKIPPED"
    fi
    # Ust uste binmeyi engelle. `ensure` dakikada bir cron'dan cagriliyor ama
    # bir veritabanini kaldirmak 30 saniyeye kadar surebiliyor; bozuk bir
    # PostgreSQL'de turlar birikip ayni anda birden fazla `pg_ctl start`
    # calistirirdi. mkdir cekirdek duzeyinde atomiktir.
    ENSURE_LOCK="$RUN_DIR/.ensure.lock"
    if ! mkdir "$ENSURE_LOCK" 2>/dev/null; then
      # Onceki tur cakilip kilidi birakmamis olabilir; 5 dakikadan eskisini at.
      if [ -d "$ENSURE_LOCK" ] && [ -z "$(find "$ENSURE_LOCK" -maxdepth 0 -mmin -5 2>/dev/null)" ]; then
        rmdir "$ENSURE_LOCK" 2>/dev/null || true
      fi
      exit "$ENSURE_SKIPPED"
    fi
    # HUP ve PIPE de yakalanir. EXIT/INT/TERM yetmiyor: cikti bir boruya
    # yaziliyorsa (`service.sh ensure | head`) borunun ucu kapaninca surec
    # SIGPIPE ile oldurulur ve kilit ARDA KALIR. Bu gercekten yasandi —
    # kilit 5 dakikalik bayatlik siniri dolana kadar sonraki turlari
    # engelledi. SIGHUP da ayni sekilde: cagiran terminal kapanabilir.
    trap 'rmdir "$ENSURE_LOCK" 2>/dev/null || true' EXIT INT TERM HUP PIPE
    # Once veritabanlari: api onlara baglanamazsa saniyede bir yeniden
    # baslatma dongusune girer (ECONNREFUSED 127.0.0.1:5433). Sirayi ters
    # cevirmek watchdog'u calisir gosterip paneli bozuk birakirdi.
    for s in $DB_SERVICES; do
      if ! db_running "$s"; then
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $s calismiyor, baslatiliyor"
        db_start_one "$s"
      fi
    done
    # PHP-FPM: musteri sitelerinin PHP'si. Panel ayakta ama bu olu ise
    # musteri siteleri 502 verir; watchdog bunu da kaldirir.
    if ! php_fpm_running; then
      echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $PHP_FPM_SERVICE calismiyor, baslatiliyor"
      php_fpm_start || true
    fi
    for s in $ALL_SERVICES; do
      if ! supervisor_alive "$s"; then
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $s gozetmeni yok, baslatiliyor"
        start_one "$s"
      fi
    done
    ;;
  install-watchdog)
    # Panelin SAHIP OLDUGU zamanlanmis isler. Her biri once crontab'dan
    # silinip yeniden yazilir (idempotent); baska kayitlara dokunulmaz.
    #
    # SSL YENILEME NEDEN BURADA: `ssl-renew.sh` yazilmis ve dogruydu ama
    # crontab'a HIC EKLENMEMISTI — yalnizca crontab.studio-panel.example
    # icinde ornek olarak duruyordu. Yani sertifikalar 90 gun sonra sessizce
    # olecekti ve bunu ancak site HTTPS vermeyi birakinca ogrenecektik.
    # "Yazilmis ama baglanmamis otomasyon", hic yazilmamis olandan daha
    # tehlikeli: var sanip guveniyorsun.
    TMP="$(mktemp)"
    chmod 600 "$TMP"
    sudo cat /etc/crontabs/devuser 2>/dev/null \
      | grep -v 'service.sh ensure' \
      | grep -v 'ssl-renew.sh' \
      | grep -v 'ssl-bootstrap.sh' \
      | grep -v 'backup-run.sh' \
      | grep -v 'backup-verify.sh' \
      | grep -v 'backup-scheduled.sh' \
      > "$TMP" || true
    echo "* * * * * $PROJECT_ROOT/ops/scripts/service.sh ensure >> $PROJECT_ROOT/ops/watchdog.log 2>&1" >> "$TMP"
    # Gunluk 03:17 UTC — yogun saat disi ve yuvarlak olmayan bir dakika
    # (Let's Encrypt tarafinda ayni dakikada toplanmayi onler).
    # ssl-renew.sh root ister; certbot ve `docker cp` icin.
    echo "17 3 * * * sudo $PROJECT_ROOT/ops/scripts/ssl-renew.sh >> $PROJECT_ROOT/ops/ssl-renew.log 2>&1" >> "$TMP"
    # İlk kurulumda DNS hazır değilse 15 dakikada bir tekrar dene. A kaydı
    # doğru IP'ye dönmeden Certbot çağrılmadığı için gereksiz istek gönderilmez.
    echo "*/15 * * * * sudo $PROJECT_ROOT/ops/scripts/ssl-bootstrap.sh >> $PROJECT_ROOT/ops/ssl-bootstrap.log 2>&1" >> "$TMP"
    # Gunluk yedek, gece 02:40 (SSL yenilemesinden once, cakismasin diye).
    echo "40 2 * * * $PROJECT_ROOT/ops/scripts/backup-scheduled.sh run >> $PROJECT_ROOT/ops/backup.log 2>&1" >> "$TMP"
    # HAFTALIK GERI YUKLEME TESTI (pazar 04:20). Bu satir olmadan yedekler
    # "dogrulanmadi" olarak kalir ve panel onlari yesil GOSTERMEZ — cunku
    # denenmemis yedek, calisir yedek degildir.
    echo "20 4 * * 0 $PROJECT_ROOT/ops/scripts/backup-scheduled.sh verify >> $PROJECT_ROOT/ops/backup.log 2>&1" >> "$TMP"
    # `install` sahiplik ve izni ATOMIK olarak yerine koyar. Onceki surum
    # cp + chown + chmod sirasi kullaniyordu; cp ile chmod arasinda dosya
    # kisa bir sure genis izinle duruyordu.
    sudo install -m 600 -o root -g root "$TMP" /etc/crontabs/devuser
    rm -f "$TMP"
    echo "✓ Watchdog kuruldu: /etc/crontabs/devuser"
    sudo cat /etc/crontabs/devuser
    ;;
  *)
    echo "Kullanim: $0 {start|stop|restart|status|ensure|maintenance-on|maintenance-off|install-watchdog} [api|web|adminer|postgres|mariadb|php-fpm|all]" >&2
    exit 2
    ;;
esac
