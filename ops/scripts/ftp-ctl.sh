#!/usr/bin/env bash
# ops/scripts/ftp-ctl.sh {reload|ensure|status}
#
# PROD. pure-ftpd sanal kullanıcı veritabanını (PureDB) panelin ürettiği
# düz metin dosyasından (ops/generated/pureftpd.passwd, bkz.
# apps/api/src/lib/ftp.ts) derler ve daemonu (yeniden) başlatır.
#
# NEDEN RESTART: PureDB backend .pdb dosyasını sadece başlangıçta okur,
# canlı sorgu yapmaz (MySQL/LDAP backend'lerin aksine) — hesap değişikliği
# ancak restart ile devreye girer. Bu yüzden her hesap değişikliğinde
# API bu script'i çağırır (nginx -s reload / rndc reload ile aynı desen).
#
# deploy-vhost.sh / deploy-zone.sh ile AYNI güvenlik deseni: apps/api bu
# script'i SADECE sudoers'ta bu tek script'e tanımlanmış dar kapsamlı,
# şifresiz bir kuralla çağırır.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $*' ile çalıştırın."

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASSWD_SRC="$PROJECT_ROOT/ops/generated/pureftpd.passwd"
PDB="/etc/pure-ftpd/pureftpd.pdb"
PIDFILE="/var/run/pure-ftpd.pid"

# Disaridan gelen baglantilarda PASV yaniti hangi IP'yi soyler — ssl-issue.sh
# ile AYNI kaynak/desen (.env.loopkit'teki SERVER_PUBLIC_IP).
SERVER_IP="$(grep -E '^SERVER_PUBLIC_IP=' "$PROJECT_ROOT/.env.loopkit" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"

# Daemon ayakta mı?
#
# PIDFILE TEK BAŞINA YETMEZ — bunu sadece pidfile'a sorarsak, pidfile
# kaybolduğu anda ÇALIŞAN daemon "ölü" sayılır ve watchdog onu dakikada bir
# yeniden başlatmaya çalışır. Her deneme "Unable to start a standalone server:
# Address in use" ile düşer, çünkü servis zaten ayaktadır.
#
# GERÇEKTEN YAŞANDI: 2026-08-31'de bulunduğunda pure-ftpd port 21'de hizmet
# veriyordu (protokol "220 Welcome to Pure-FTPd." yanıtı doğrulandı) ama
# /var/run/pure-ftpd.pid yoktu; ops/watchdog.log'da bu yüzden birikmiş
# 2.881 satır hata vardı ve sayı dakikada iki artıyordu. Gerçek arızalar bu
# gürültünün içinde görünmez hale gelmişti.
#
# Aynı ders bu projede daha önce iki kez öğrenildi (service.sh: pid'e değil
# PORTA bak; port_healthy: curl çıktısını doğru oku). Sağlık kontrolü
# defterdeki kayda değil, DÜNYANIN GERÇEK DURUMUNA bakmalı.
#
# Sıra: önce pidfile (ucuz ve kesin), sonra portun gerçek sahibi.
is_running() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    return 0
  fi
  # Port 21'i dinleyen süreç gerçekten pure-ftpd mi? Yalnızca "port dolu"
  # demek yetmez — başka bir servis 21'i tutuyorsa onu pure-ftpd sanıp
  # sessizce "çalışıyor" demek, ilk hatanın aynadaki görüntüsü olurdu.
  local pid
  pid="$(netstat -tlnp 2>/dev/null \
    | awk '$4 ~ /:21$/ {split($7,a,"/"); if (a[1] != "" && a[1] != "-") {print a[1]; exit}}')"
  [ -n "$pid" ] || return 1
  [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "pure-ftpd" ] || return 1

  # Sahibini bulduk ama pidfile yok: bir dahaki tura kalmasın diye yaz.
  # Böylece hem bu tur doğru cevap verir hem de kayıt gerçekle hizalanır.
  echo "$pid" > "$PIDFILE" 2>/dev/null || true
  return 0
}

# Alpine'in pure-ftpd paketi /etc/pure-ftpd.conf'u OKUMAZ — bu dosya
# yalnızca Debian'ın pure-config.pl aracıyla anlamlı (Alpine'de yok).
# Gerçek çalışma zamanı yapılandırması CLI bayraklarıyla verilir; anlamları
# upstream README'den doğrulandı (bkz. commit mesajı). Anonim erişim
# KAPALI (-E), her kullanıcı kendi dizinine chroot (-A), kimlik doğrulama
# sadece PureDB (-l), TLS opsiyonel/tercihen (-Y 1, kendinden imzalı sertifika).
start_daemon() {
  # -P <ip>: PASV/EPSV yanitinda bu IP soylenir (NAT arkasindaki sunucular
  # icin upstream'in resmi "forced IP" bayragi). GEREKLI — bu konteyner
  # Docker bridge arkasinda (172.18.0.2 gibi); -P OLMADAN pure-ftpd PASV
  # cevabinda kendi ic/private arayuz adresini bildirir, disaridaki bir
  # istemci o adrese HICBIR ZAMAN ulasamaz (private IP, internet'ten
  # yonlendirilemez). Kontrol kanali (21) acilir, giris bile basarili olur
  # ama LIST/STOR icin veri kanali kurulamadigindan istemci "izin verilmedi"
  # tarzi bir hata gorur — 2026-09-27'de tam bu sikayetle bulundu: yerel
  # 127.0.0.1 testi calisiyordu ("PASV yaniti: 127,0,0,1,..."), yani sorun
  # kimlik/chroot degil, YALNIZCA PASV adresiydi.
  #
  # DIKKAT — burada `-S` DEGIL `-P` kullanilir: `-S <ip>` pure-ftpd'de
  # dinleme soketini o adrese BAGLAR (standalone bind address), masquerade
  # DEGILDIR. Ilk denemede `-S` kullanildi ve konteynerde o IP hicbir
  # arayuzde bulunmadigindan "Unable to start a standalone server: Address
  # not available" ile servis TAMAMEN AYAGA KALKAMADI (canli kesinti —
  # ayni oturumda strace ile teshis edilip aninda duzeltildi). `-P` ise
  # dinlemeyi degistirmez, sadece PASV cevabindaki IP'yi degistirir.
  #
  # SERVER_PUBLIC_IP tanimli degilse eski davranis (bayraksiz) korunur —
  # sessizce yanlis IP soylemektense en azindan mevcut davranisi bozmamak
  # tercih edildi; boyle bir durumda .env.loopkit'e SERVER_PUBLIC_IP eklenmeli.
  local server_ip_args=()
  if [ -n "$SERVER_IP" ]; then
    server_ip_args=(-P "$SERVER_IP")
  fi
  pure-ftpd \
    -A -B -E \
    -l "puredb:$PDB" \
    -g "$PIDFILE" \
    -p 30000:30100 \
    -u 1000 \
    -U 133:022 \
    -Y 1 \
    "${server_ip_args[@]}"
  for _ in $(seq 1 20); do
    is_running && return 0
    sleep 0.2
  done
  fail "pure-ftpd başlatılamadı (pidfile oluşmadı)."
}

stop_daemon() {
  is_running || return 0
  kill "$(cat "$PIDFILE")"
  for _ in $(seq 1 20); do
    is_running || return 0
    sleep 0.2
  done
  kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
}

case "${1:-}" in
  reload)
    [ -f "$PASSWD_SRC" ] || fail "Kaynak bulunamadı: $PASSWD_SRC"
    echo "» PureDB derleniyor..."
    pure-pw mkdb "$PDB" -f "$PASSWD_SRC"
    chmod 600 "$PDB"
    echo "» pure-ftpd yeniden başlatılıyor (PureDB canlı sorgu desteklemiyor)..."
    stop_daemon
    start_daemon
    echo "✓ pure-ftpd yeniden yüklendi (pid $(cat "$PIDFILE"))."
    ;;
  ensure)
    # Watchdog: crond'dan dakikada bir çağrılır, sessiz çalışır.
    if ! is_running; then
      echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] pure-ftpd çalışmıyor, başlatılıyor"
      [ -f "$PDB" ] || { pure-pw mkdb "$PDB" -f "$PASSWD_SRC" 2>/dev/null || true; }
      start_daemon
    fi
    ;;
  status)
    if is_running; then
      echo "pure-ftpd çalışıyor (pid $(cat "$PIDFILE"))."
    else
      echo "pure-ftpd çalışmıyor."
    fi
    ;;
  *)
    echo "Kullanım: $0 {reload|ensure|status}" >&2
    exit 2
    ;;
esac
