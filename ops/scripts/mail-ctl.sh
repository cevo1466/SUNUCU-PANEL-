#!/usr/bin/env bash
# ops/scripts/mail-ctl.sh {start|stop|ensure|status|reload}
#
# PROD. Postfix + Dovecot + OpenDKIM'i panelin ürettiği kaynak dosyalardan
# (ops/generated/dovecot-users, ops/generated/postfix-vmailbox-domains,
# ops/generated/dkim/<domain>/default.private.pem) besler — deploy-vhost.sh /
# ftp-ctl.sh / deploy-zone.sh ile AYNI desen. Kaynak dosyalar devuser'a ait ve
# 0600 (parola hash'i taşıyorlar); bu script ROOT olarak çalışıp bunları
# ilgili daemon'ın okuyabileceği root-sahipli konumlara KOPYALAR — panelin
# API kodu hiçbir zaman root-sahipli dosyaya doğrudan yazmaz.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir. 'sudo $0 $*' ile çalıştırın."

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOVECOT_USERS_SRC="$PROJECT_ROOT/ops/generated/dovecot-users"
VMAILBOX_DOMAINS_SRC="$PROJECT_ROOT/ops/generated/postfix-vmailbox-domains"
DKIM_DIR="$PROJECT_ROOT/ops/generated/dkim"

DOVECOT_PIDFILE="/var/run/dovecot/master.pid"
OPENDKIM_PIDFILE="/run/opendkim/opendkim.pid"
POSTFIX_PIDFILE="/var/spool/postfix/pid/master.pid"

dovecot_running() { [ -f "$DOVECOT_PIDFILE" ] && kill -0 "$(cat "$DOVECOT_PIDFILE")" 2>/dev/null; }
opendkim_running() { [ -f "$OPENDKIM_PIDFILE" ] && kill -0 "$(cat "$OPENDKIM_PIDFILE")" 2>/dev/null; }
postfix_running() { [ -f "$POSTFIX_PIDFILE" ] && kill -0 "$(cat "$POSTFIX_PIDFILE")" 2>/dev/null; }

# --- kaynak dosyaları senkronize et ---

sync_dovecot_passwd() {
  [ -f "$DOVECOT_USERS_SRC" ] || { echo "» dovecot-users henüz üretilmedi, atlanıyor." ; return 0; }
  install -o root -g dovecot -m 640 "$DOVECOT_USERS_SRC" /etc/dovecot/passwd
}

sync_vmailbox_domains() {
  [ -f "$VMAILBOX_DOMAINS_SRC" ] || : > "$VMAILBOX_DOMAINS_SRC"
  install -o root -g root -m 644 "$VMAILBOX_DOMAINS_SRC" /etc/postfix/vmailbox_domains
  # Bu Alpine derlemesinde Berkeley DB (hash:) YOK — main.cf lmdb: kullanıyor.
  postmap lmdb:/etc/postfix/vmailbox_domains
}

# DKIM anahtarlarını sadece GERÇEK mail hesabı olan domainler için taşır —
# self-test'in ürettiği onlarca test.invalid anahtarı OpenDKIM'e hiç girmez
# (bkz. ops/generated/dkim/, doğal olarak vmailbox_domains'te yer almazlar).
# OpenDKIM'e tablolari YENIDEN OKUT.
#
# GERCEK ARIZA (2026-09-02): `reload` KeyTable/SigningTable dosyalarini
# yeniden yaziyor ama opendkim'e hicbir sey soylemiyordu. OpenDKIM bu
# tablolari YALNIZCA baslangicta okur; zaten calisiyorsa `start_opendkim`
# hicbir sey yapmaz. Sonuc: panelden acilan yeni bir posta domaini HIC
# imzalanmiyordu — Hotmail "gonderenin geldigini dogrulayamadik" diyordu ve
# sebebi gorunmuyordu, cunku KeyTable dogru, anahtar dogru, DNS dogruydu;
# yalnizca surec onlari bilmiyordu. Postfix ve Dovecot reload ediliyordu,
# opendkim atlanmisti.
#
# SIGUSR1 opendkim'in belgelenmis yeniden yukleme sinyali; surec
# oldurulmedigi icin akistaki mesaj etkilenmez (yeniden baslatmak
# milter'i kisa sureligine kapatir ve o aralikta giden posta IMZASIZ
# cikardi).
reload_opendkim() {
  if opendkim_running; then
    kill -USR1 "$(cat "$OPENDKIM_PIDFILE")" 2>/dev/null \
      && echo "  · opendkim tablolari yeniden okundu (SIGUSR1)" \
      || echo "  ! opendkim'e SIGUSR1 gonderilemedi" >&2
  fi
}

sync_opendkim_keys() {
  mkdir -p /etc/opendkim/keys
  : > /etc/opendkim/KeyTable
  : > /etc/opendkim/SigningTable
  [ -f "$VMAILBOX_DOMAINS_SRC" ] || return 0
  while IFS=$'\t' read -r domain _rest; do
    [ -n "$domain" ] || continue
    local_key="$DKIM_DIR/$domain/default.private.pem"
    [ -f "$local_key" ] || continue
    mkdir -p "/etc/opendkim/keys/$domain"
    install -o opendkim -g opendkim -m 400 "$local_key" "/etc/opendkim/keys/$domain/default.private"
    echo "default._domainkey.${domain} ${domain}:default:/etc/opendkim/keys/${domain}/default.private" >> /etc/opendkim/KeyTable
    echo "*@${domain} default._domainkey.${domain}" >> /etc/opendkim/SigningTable
  done < "$VMAILBOX_DOMAINS_SRC"
  chown root:opendkim /etc/opendkim/KeyTable /etc/opendkim/SigningTable
  chmod 640 /etc/opendkim/KeyTable /etc/opendkim/SigningTable
}

# --- daemon start/stop ---

start_dovecot() {
  dovecot_running && return 0
  dovecot -c /etc/dovecot/dovecot.conf
  for _ in $(seq 1 30); do dovecot_running && return 0; sleep 0.2; done
  fail "dovecot başlatılamadı."
}
stop_dovecot() {
  dovecot_running || return 0
  kill "$(cat "$DOVECOT_PIDFILE")"
  for _ in $(seq 1 30); do dovecot_running || return 0; sleep 0.2; done
}

start_opendkim() {
  opendkim_running && return 0
  /usr/sbin/opendkim -x /etc/opendkim/opendkim.conf -u opendkim
  for _ in $(seq 1 30); do opendkim_running && return 0; sleep 0.2; done
  fail "opendkim başlatılamadı."
}
stop_opendkim() {
  opendkim_running || return 0
  kill "$(cat "$OPENDKIM_PIDFILE")"
  for _ in $(seq 1 30); do opendkim_running || return 0; sleep 0.2; done
}

start_postfix() {
  postfix_running && return 0
  postfix start
  for _ in $(seq 1 30); do postfix_running && return 0; sleep 0.2; done
  fail "postfix başlatılamadı."
}
stop_postfix() {
  postfix_running || return 0
  postfix stop
}

case "${1:-}" in
  reload)
    sync_dovecot_passwd
    sync_vmailbox_domains
    sync_opendkim_keys
    start_opendkim; start_dovecot; start_postfix
    postfix reload
    dovecot_running && doveadm reload
    reload_opendkim
    echo "✓ postfix + dovecot + opendkim reload edildi."
    ;;
  start)
    sync_dovecot_passwd
    sync_vmailbox_domains
    sync_opendkim_keys
    start_opendkim
    start_dovecot
    start_postfix
    echo "✓ postfix + dovecot + opendkim çalışıyor."
    ;;
  stop)
    stop_postfix
    stop_dovecot
    stop_opendkim
    ;;
  ensure)
    opendkim_running || { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] opendkim çalışmıyor, başlatılıyor"; start_opendkim; }
    dovecot_running  || { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] dovecot çalışmıyor, başlatılıyor"; start_dovecot; }
    postfix_running  || { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] postfix çalışmıyor, başlatılıyor"; start_postfix; }
    ;;
  status)
    opendkim_running && echo "opendkim çalışıyor." || echo "opendkim çalışmıyor."
    dovecot_running && echo "dovecot çalışıyor." || echo "dovecot çalışmıyor."
    postfix_running && echo "postfix çalışıyor." || echo "postfix çalışmıyor."
    ;;
  *)
    echo "Kullanım: $0 {start|stop|reload|ensure|status}" >&2
    exit 2
    ;;
esac
