#!/usr/bin/env bash
# ops/scripts/dns-ctl.sh {start|stop|ensure|status}
#
# PROD. named (BIND9) daemonunu bu konteynerde ayakta tutar — screen/OpenRC
# YOK, projenin geri kalanıyla aynı desen (bkz. service.sh, ftp-ctl.sh).
# Zone içeriği bu script'in işi değil: onu deploy-zone.sh (named-checkzone +
# rndc reload) yönetir. Bu script SADECE daemonun kendisinin ayakta olmasını
# sağlar — watchdog'un dakikada bir çağırdığı "ensure" burada yaşar.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $*' ile çalıştırın."

PIDFILE="/var/run/named/named.pid"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

start_daemon() {
  named-checkconf /etc/bind/named.conf || fail "named.conf geçersiz — başlatılmadı."
  # /etc/bind varsayılan olarak root:named 0750 — panel API'si (devuser)
  # /etc/bind/zones/*.zone dosyalarının VARLIĞINI kontrol edemez (isZoneDeployed),
  # üst dizine geçiş izni bile yok. o+x SADECE geçiş (traverse) izni verir —
  # rndc.key/named.conf gibi dosyalar kendi 0640/0600 izinleriyle korunmaya
  # devam eder, devuser onları LİSTELEYEMEZ/OKUYAMAZ, sadece alt dizinlere
  # inebilir. 2026-08-29'da gerçek self-test ile bulundu (applied:true ama
  # zone_deployed hep false görünüyordu).
  chmod o+x /etc/bind
  if ! named -u named -c /etc/bind/named.conf; then
    timeout 5 named -g -u named -c /etc/bind/named.conf 2>&1 | tail -40 || true
    fail "named başlatma komutu başarısız."
  fi
  for _ in $(seq 1 30); do
    is_running && return 0
    sleep 0.2
  done
  # Başlatma başarısızsa BIND'in kendi tanısını watchdog günlüğüne yaz.
  timeout 5 named -g -u named -c /etc/bind/named.conf 2>&1 | tail -40 || true
  fail "named başlatılamadı (pidfile oluşmadı)."
}

stop_daemon() {
  is_running || return 0
  kill "$(cat "$PIDFILE")"
  for _ in $(seq 1 30); do
    is_running || return 0
    sleep 0.2
  done
  kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
}

case "${1:-}" in
  start)   is_running || start_daemon; echo "✓ named çalışıyor (pid $(cat "$PIDFILE"))." ;;
  stop)    stop_daemon ;;
  restart) stop_daemon; start_daemon; echo "✓ named yeniden başlatıldı (pid $(cat "$PIDFILE"))." ;;
  ensure)
    if ! is_running; then
      echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] named çalışmıyor, başlatılıyor"
      start_daemon
    fi
    ;;
  status)
    if is_running; then echo "named çalışıyor (pid $(cat "$PIDFILE"))."; else echo "named çalışmıyor."; fi
    ;;
  *)
    echo "Kullanım: $0 {start|stop|restart|ensure|status}" >&2
    exit 2
    ;;
esac
