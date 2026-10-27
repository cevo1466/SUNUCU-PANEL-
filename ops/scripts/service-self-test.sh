#!/bin/sh
# service.sh — sozlesme testi.
#
# NEDEN VAR: bu script'in en tehlikeli hata bicimi cokmek DEGIL, "yaptim"
# deyip yapmamaktir. Dosyanin kendi basligi bunu iki kez anlatiyor (screen
# olayi, root'a ait eski surece 200 alip deploy'u basarili sayma). Ayni tuzaga
# veritabani komutlari eklenirken tekrar dusuldu, bu yuzden artik test var.
#
# Calisan panele DOKUNMAZ: yalnizca "yapmamasi gereken" komutlari cagirir ve
# cikis kodu / yan etki denetler.
set -u
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SVC="$ROOT/ops/scripts/service.sh"
fail=0

check() {
  name="$1"; shift
  if "$@"; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name"
    fail=$((fail + 1))
  fi
}

# DIKKAT: kalip SONA sabitlenir (":5433$"). Ilk surumde ":5433 " (sondaki
# bosluk) araniyordu; netstat'in yerel adres alani "127.0.0.1:5433" olarak
# BITTIGI icin hicbir zaman eslesmedi, fonksiyon hep bos dondu ve restart
# testi HIC BASARISIZ OLAMADI — yani testin kendisi sessizce ise yaramazdi.
pid_on_port() {
  sudo -n netstat -tlnp 2>/dev/null \
    | awk -v p=":$1\$" '$4 ~ p {split($7,a,"/"); if (a[1] != "" && a[1] != "-") {print a[1]; exit}}'
}

echo "— veritabani komutlari dogruyu soyluyor mu"

# 1) `stop <db>` durdurmadigini SOYLEMELI ve sifir DISI donmeli.
#    Sifir donerse `service.sh stop postgres && sonraki_adim` zinciri
#    veritabani durmus gibi devam eder.
stop_reports_failure() {
  "$SVC" stop postgres >/dev/null 2>&1
  [ "$?" -ne 0 ]
}
check "stop postgres sifir DISI donuyor (durdurmadigi icin)" stop_reports_failure

# 2) `restart <db>` gercekten yeniden baslatmiyorsa BASARILI DONMEMELI.
#    Eski hali "zaten calisiyor" deyip 0 donuyordu: operator yeniden
#    baslatildigini saniyordu, surec PID'i ayni kaliyordu.
restart_does_not_lie() {
  before="$(pid_on_port 5433)"
  "$SVC" restart postgres >/dev/null 2>&1
  code=$?
  after="$(pid_on_port 5433)"
  if [ -n "$before" ] && [ "$before" = "$after" ] && [ "$code" -eq 0 ]; then
    return 1   # hicbir sey yapmadi ama basarili dedi
  fi
  return 0
}
check "restart postgres yeniden baslatmadan BASARILI demiyor" restart_does_not_lie

# 3) Veritabanlari `all` kapsamina girmemeli: derleme icin yapilan
#    `stop all` bir veritabanini kapatmamali.
#
#    Bu, `stop all` GERCEKTEN calistirilarak dogrulanabilirdi ama o, testi her
#    `./verify.sh` kosusunda paneli birkac saniye dusuren bir islem yapardi.
#    Dogrulanan degismez statiktir: `all` kapsami (ALL_SERVICES) ile veritabani
#    listesi (DB_SERVICES) kesismemeli. Kaynagi okumak burada davranisi
#    calistirmakla ayni seyi kanitlar ve hizmete dokunmaz.
all_excludes_db() {
  all="$(sed -n 's/^ALL_SERVICES="\(.*\)"$/\1/p' "$SVC")"
  dbs="$(sed -n 's/^DB_SERVICES="\(.*\)"$/\1/p' "$SVC")"
  [ -n "$all" ] && [ -n "$dbs" ] || return 1
  for d in $dbs; do
    case " $all " in *" $d "*) return 1 ;; esac
  done
  return 0
}
check "veritabanlari 'all' kapsaminda DEGIL (stop all onlara dokunamaz)" all_excludes_db

echo "— watchdog atladigini gizlemiyor"

# 4) `ensure` kilit yuzunden hicbir sey yapmadiysa bunu cikis koduyla
#    bildirmeli. boot.sh bu adimin atlandigini baska turlu anlayamaz ve
#    "kaldirdim" diye rapor eder.
ensure_reports_skip() {
  mkdir -p "$ROOT/ops/run/.ensure.lock"
  "$SVC" ensure >/dev/null 2>&1
  code=$?
  rmdir "$ROOT/ops/run/.ensure.lock" 2>/dev/null
  [ "$code" -ne 0 ]
}
check "ensure kilit tutuluyorken sifir DISI donuyor" ensure_reports_skip

echo "— deploy script'i olu servise dayaniklı mı"

# 5) restart-services.sh `set -e` ile calisiyor. Saglik dongusundeki curl,
#    servis henuz ayaga kalkmamisken 7 ile cikar; `|| var=000` korumasi
#    olmadan `set -e` TUM SCRIPTI oldurur ve deploy yarida kalir.
#    GERCEKTEN YASANDI (2026-09-01): daha once yapilan bir "kozmetik"
#    temizlik `|| echo 000`'i kaldirinca deploy exit 7 ile dustu.
health_loop_guarded() {
  for f in "$ROOT/ops/scripts/restart-services.sh" "$ROOT/ops/scripts/boot.sh"; do
    # curl ile deger atayan her satirda bir geri dusus olmali.
    while IFS= read -r line; do
      case "$line" in
        *'=$(curl '*)
          case "$line" in
            *'|| '*'=000'*) : ;;
            *) return 1 ;;
          esac
          ;;
      esac
    done < "$f"
  done
  return 0
}
check "saglik dongusundeki curl'ler geri dususe sahip (set -e oldurmez)" health_loop_guarded

# --- Panel dis kapisi kontrolu 301'e KANMAMALI ---
#
# 2026-09-03: IP ve bilinmeyen adlar kanonik panel adresine 301 ile
# yonlendirilmeye baslandi. `http://127.0.0.1/login` artik upstream'e HIC
# dokunmadan 301 donuyor. Bu kontrol 502'yi yakalamak icin var; duz HTTP ile
# olcmeye devam etmek deploy'u "saglikli degil" diye durdurdu, 301'i saglikli
# saymak ise kontrolu tamamen anlamsiz kilardi. Degisiklik saglik kontrolunu
# GERCEKTEN bozdu; bu test bir daha sessizce bozulmasini engeller.
panel_edge_measures_real_path() {
  for f in restart-services.sh boot.sh; do
    # `edge=` ATAMASI aranir, duz curl degil: panel_edge_code icindeki
    # gecerli geri dusus satiri (panel SSL'i henuz kurulmamissa duz HTTP)
    # ayni deseni tasiyor ve genis bir arama ona kaniyor.
    if grep -qE '^\s*edge=\$\(curl.*http://127\.0\.0\.1/login' "$ROOT/ops/scripts/$f"; then
      echo "    $f hala duz HTTP ile olcuyor — yonlendirme yuzunden 301 doner" >&2
      return 1
    fi
    if ! grep -q "panel_edge_code" "$ROOT/ops/scripts/$f"; then
      echo "    $f panel_edge_code kullanmali" >&2
      return 1
    fi
  done
  # Hostname koda gomulmemeli: panel-ssl.sh baska bir adla calistirilirsa
  # kontrol de onu takip etmeli.
  grep -q "studio-panel-ssl.conf" "$ROOT/ops/scripts/restart-services.sh" || {
    echo "    hostname koda gomulmus olabilir" >&2; return 1; }
  return 0
}
check "panel dis kapisi kontrolu gercek panel yolunu olcer" panel_edge_measures_real_path

echo "— Adminer dogru PostgreSQL sunucusuyla aciliyor mu"

# Adminer'in kendi dosyasi vendor/ignore altinda. Varsayilan baglanti burada,
# repoda takip edilen giris katmaninda uygulanir; aksi halde "localhost"
# Adminer'in standart 5432 portuna giderken panel PostgreSQL'i 5433'te kalir.
adminer_defaults_to_panel_postgres() {
  entry="$ROOT/ops/scripts/adminer-entry.php"
  supervisor="$ROOT/ops/scripts/supervise.sh"

  [ -f "$entry" ] || {
    echo "    Adminer giris katmani yok: $entry" >&2
    return 1
  }
  grep -q 'adminer-entry\.php' "$supervisor" || {
    echo "    supervise.sh Adminer giris katmanini kullanmiyor" >&2
    return 1
  }

  php_bin=""
  for candidate in php84 php83 php82 php; do
    if command -v "$candidate" >/dev/null 2>&1; then
      php_bin="$candidate"
      break
    fi
  done
  # Adminer opsiyonel olabilir; PHP yoksa yukaridaki dosya+wiring kontrolu
  # yine regressioni yakalar. PHP varsa davranisi da gercekten calistiririz.
  [ -n "$php_bin" ] || return 0

  result="$($php_bin -r '
    define("STUDIO_PANEL_ADMINER_ENTRY_TEST", true);
    $_GET = [];
    $_POST = [];
    $_SERVER["REQUEST_METHOD"] = "GET";
    require $argv[1];
    echo $_GET["pgsql"] ?? "missing";
  ' "$entry")" || return 1
  [ "$result" = "127.0.0.1:5433" ] || {
    echo "    bos Adminer formu yanlis sunucuyla aciliyor: $result" >&2
    return 1
  }

  result="$($php_bin -r '
    define("STUDIO_PANEL_ADMINER_ENTRY_TEST", true);
    $_GET = ["server" => "127.0.0.1:3306"];
    $_POST = [];
    $_SERVER["REQUEST_METHOD"] = "GET";
    require $argv[1];
    echo isset($_GET["pgsql"]) ? "overridden" : $_GET["server"];
  ' "$entry")" || return 1
  [ "$result" = "127.0.0.1:3306" ] || {
    echo "    mevcut Adminer motor secimi eziliyor: $result" >&2
    return 1
  }

  result="$($php_bin -r '
    define("STUDIO_PANEL_ADMINER_ENTRY_TEST", true);
    $_GET = [];
    $_POST = ["auth" => ["driver" => "pgsql"]];
    $_SERVER["REQUEST_METHOD"] = "POST";
    require $argv[1];
    echo isset($_GET["pgsql"]) ? "overridden" : "preserved";
  ' "$entry")" || return 1
  [ "$result" = "preserved" ] || {
    echo "    Adminer login POST istegi eziliyor: $result" >&2
    return 1
  }
}
check "Adminer bos formu 127.0.0.1:5433 PostgreSQL ile aciyor" adminer_defaults_to_panel_postgres

if [ "$fail" -ne 0 ]; then
  echo "✗ service.sh self-test: $fail test kaldi."
  exit 1
fi
echo "✓ service.sh self-test gecti (veritabani komutlari ve watchdog dogruyu soyluyor)"
