#!/bin/sh
# Studio Panel — konteyner yeniden basladiktan sonra tum yigini kaldirir.
#
# NEDEN VAR (kok neden, Oturum 2026-08-31):
#   Kullanici diski 50 GB'dan 100 GB'a cikarmak icin Docker'i durdurdu.
#   Konteyner geri geldiginde PID 1 yalnizca `dockerd` idi — bu konteynerde
#   OpenRC/systemd yok, `/etc/local.d` yok, hicbir init servisi yok. Sonuc:
#     - api (3001) ve web (3000) baslamadi → dis nginx konteyneri upstream'e
#       ulasamayip **502 Bad Gateway** dondurdu,
#     - PostgreSQL baslamadi → api elle kaldirilsa bile
#       "ECONNREFUSED 127.0.0.1:5433" ile saniyede bir dususe girdi,
#     - **crond baslamadi** → dakikalik watchdog'un (`service.sh ensure`)
#       kendisi de olu kaldi. Yani "duseni kaldiran" mekanizma, dusmustu.
#       Kendi kendini iyilestirme zincirinin ilk halkasi budur; o kalkmadan
#       digerleri de kalkmaz.
#   Panelin geri gelmesi, sorunu tesbit edip her servisi elle baslatmayi
#   gerektirdi. Bu script o teshisi bir komuta indirger.
#
# NE ZAMAN CALISTIRILIR: konteyner her yeniden basladiginda, bir kez.
#   /var/www/vhosts/studio-panel/ops/scripts/boot.sh
#
# Idempotenttir: zaten calisan hicbir servise dokunmaz, tekrar tekrar
# calistirilabilir. Veritabanlari asla oldurulmez (bkz. service.sh DB_SERVICES).

set -u

# Panelin DIS KAPISINI olcer: nginx konteyneri gercekten upstream'e ulasiyor mu?
#
# NEDEN DUZ HTTP YETMIYOR (2026-09-03): IP ve bilinmeyen adlar artik kanonik
# panel adresine 301 ile yonlendiriliyor (bkz. studio-panel.conf). Yani
# `http://127.0.0.1/login` upstream'e HIC dokunmadan 301 donuyor — bu kontrol
# 502'yi yakalamak icin vardi ve 301'i "saglikli" saymak onu anlamsiz
# kilardi. Bu degisiklik saglik kontrolunu gercekten bozdu ve deploy
# "servisler saglikli yanit vermedi" dedi.
#
# Hostname config'ten OKUNUYOR, koda gomulmuyor: panel-ssl.sh baska bir adla
# calistirilirsa kontrol de onu takip etsin. -k bilincli: burada sertifika
# gecerliligi degil, nginx'in upstream'e ULASABILDIGI olculuyor.
panel_edge_code() {
  _pe_host="$(sed -n '/listen 443/,/server_name/p' /etc/nginx/conf.d/studio-panel-ssl.conf 2>/dev/null \
    | awk '/server_name/{print $2}' | tr -d ';' | head -1)"
  if [ -n "$_pe_host" ]; then
    curl -s -o /dev/null -m 5 -k --resolve "$_pe_host:443:127.0.0.1" \
      -w '%{http_code}' "https://$_pe_host/login" 2>/dev/null
  else
    # Panel SSL'i henuz kurulmamis: eski duz HTTP yolu hala gecerli.
    curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1/login 2>/dev/null
  fi
}

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SERVICE="$PROJECT_ROOT/ops/scripts/service.sh"
cd "$PROJECT_ROOT"

fail=0
step() { echo; echo "== $*"; }

# Adi tam olarak $1 olan bir surec var mi?
#
# NEDEN pgrep DEGIL: bu sistemde /usr/bin/pgrep busybox'a sembolik bag ve
# `pgrep -x crond` CALISAN crond'u BULAMIYOR — busybox tam eslesmeyi surec
# adiyla (/proc/<pid>/comm) degil komut satiriyla yapiyor, o da
# "/usr/sbin/crond". `pgrep -f crond` ise ters yonde hatali: kalibi komut
# satirinda tasiyan CAGIRAN KABUGUN kendisiyle eslesir (ayni tuzak
# service.sh reap_orphans yorumunda anlatiliyor; bu oturumda
# `pkill -f pure-ftpd` calistiran kabuk kendini oldurdu).
# /proc/<pid>/comm dogrudan okunur: devuser icin okunabilir ve kesin.
proc_comm_running() {
  for c in /proc/[0-9]*/comm; do
    [ -r "$c" ] || continue
    [ "$(cat "$c" 2>/dev/null)" = "$1" ] && return 0
  done
  return 1
}

# 0) Geride kalmis BAKIM kilidini temizle.
#
# NEDEN: bakim kilidi `ensure`'u tamamen susturur ve 30 dakika yas siniri var.
# Konteyner yeniden basladiysa o kilidi koyan derleme artik yasamiyordur —
# yine de dosya diskte durur ve panel bosuna yarim saat kapali kalirdi.
#
# `.ensure.lock` BILEREK ELLENMIYOR. Ilk surumde o da siliniyordu; ama crond
# zaten calisiyorsa (boot.sh her an calistirilabilir, idempotent olmasi bunun
# icin) o kilidi TAM O ANDA suren bir `ensure` turu tutuyor olabilir. Silmek,
# kilidin engellemek icin var oldugu seyi — ayni anda iki `ensure` — bizzat
# mumkun kilardi. Onun bayatlik denetimi (5 dk) `ensure`'un kendi icinde,
# canli turu bozmadan yapiliyor; suren bir tura denk gelirsek asagidaki adim
# 75 alip yeniden deniyor.
step "Geride kalmis bakim kilidi"
MAINT_LOCK="$PROJECT_ROOT/ops/run/.maintenance"
if [ -e "$MAINT_LOCK" ]; then
  rm -f "$MAINT_LOCK" && echo "• bakim kilidi temizlendi (koyan surec konteynerle birlikte oldu)"
else
  echo "• bakim kilidi yok"
fi

# 1) crond — zincirin ilk halkasi.
#
# Bu paket cronie'dir (busybox/dcron degil): `-b` diye bir bayragi yoktur ve
# varsayilan olarak zaten daemon olur. Spool dizini /etc/crontabs.
step "crond"
if proc_comm_running crond; then
  echo "• crond zaten calisiyor"
else
  if sudo -n /usr/sbin/crond -s 2>&1; then
    echo "✓ crond baslatildi — dakikalik watchdog'lar yeniden isliyor"
  else
    echo "✗ crond baslatilamadi — watchdog'lar calismayacak, servisler dusunce kalkmaz" >&2
    fail=1
  fi
fi

# 2) Veritabanlari + panel servisleri.
#
# `ensure` sirayi kendisi dogru kurar: once postgres/mariadb, sonra api/web/
# adminer. Api'yi veritabanindan once kaldirmak onu yeniden baslatma
# dongusune sokardi.
step "Veritabanlari ve panel servisleri"
# `ensure` 75 dondurduyse HICBIR SEY yapmamistir (bakim kilidi ya da es zamanli
# bir tur — crond'u yeni baslattik, cron ayni saniyede tetiklemis olabilir).
# Sessizce basarili saymak, "servisleri kaldirdim" diye yanlis rapor demekti.
"$SERVICE" ensure
ensure_code=$?
if [ "$ensure_code" -eq 75 ]; then
  echo "  · baska bir tur kilidi tutuyordu, 5 sn sonra tekrar deneniyor"
  sleep 5
  "$SERVICE" ensure
  ensure_code=$?
  [ "$ensure_code" -eq 75 ] && echo "  ! ensure yine atlandi — bakim modu acik olabilir:" \
    "'$SERVICE maintenance-off' ile kapatin" >&2
fi
[ "$ensure_code" -eq 0 ] || fail=1

# 3) Sistem servisleri (DNS, mail, FTP).
#
# Bunlar zaten crond'dan dakikada bir `ensure` ediliyor; burada beklemeden
# hemen kaldirilirlar. Ciktilari /dev/null'a bagli daemon'lar bu borulari
# acik tutabildigi icin `tail`'e degil dogrudan loga yazilir (bir tur
# `... | tail` boru ucu kapanmadigi icin asilmisti).
step "DNS / mail / FTP"
for ctl in dns mail ftp; do
  script="$PROJECT_ROOT/ops/scripts/$ctl-ctl.sh"
  [ -x "$script" ] || continue
  if sudo -n "$script" ensure </dev/null >>"$PROJECT_ROOT/ops/watchdog.log" 2>&1; then
    echo "• $ctl-ctl ensure tamam"
  else
    echo "  ! $ctl-ctl ensure hata verdi — ops/watchdog.log'a bak" >&2
    fail=1
  fi
done

# 4) Dis kapidan dogrulama.
#
# 3000/3001 ayakta ama nginx yanlis upstream'e bakiyorsa panel yine bozuktur;
# 502'yi ancak bu adim yakalar (ayni gerekce: restart-services.sh).
step "Saglik kontrolu"
i=0
api=000; web=000; edge=000
while [ "$i" -lt 90 ]; do
  api=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null) || api=000
  web=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3000/login 2>/dev/null) || web=000
  edge="$(panel_edge_code)"
  [ -n "$edge" ] || edge=000
  [ "$api" = "200" ] && [ "$web" = "200" ] && [ "$edge" = "200" ] && break
  i=$((i + 1))
  sleep 1
done

echo
"$SERVICE" status
echo
if [ "$api" = "200" ] && [ "$web" = "200" ] && [ "$edge" = "200" ]; then
  echo "✓ Panel ayakta — API 200 · web 200 · nginx 200"
  exit "$fail"
fi
echo "✗ Panel 90 saniyede saglikli yanit vermedi (API=$api web=$web nginx=$edge)" >&2
echo "  Loglar: ops/api.log · ops/web.log · ops/watchdog.log · ops/run/*.boot.log" >&2
exit 1
