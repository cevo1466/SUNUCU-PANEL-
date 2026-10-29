#!/usr/bin/env bash
set -Eeuo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'HATA: root gerekli' >&2; exit 1; }
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$PROJECT_ROOT/.env.loopkit" ]] || { echo 'HATA: panel ayarları yok' >&2; exit 1; }
# shellcheck disable=SC1091
source "$PROJECT_ROOT/.env.loopkit"
if [[ "${PANEL_DOMAIN_PENDING:-0}" == 1 ]]; then
  echo 'Alan adı henüz tanımlı değil; SSL beklemede.'
  exit 0
fi
: "${PANEL_HOSTNAME:?}"
: "${MAIL_HOSTNAME:?}"
: "${SERVER_PUBLIC_IP:?}"

points_here() {
  local host="$1" ips
  ips="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)"
  [[ "$ips" == "$SERVER_PUBLIC_IP" ]]
}

failed=0
panel_conf=/etc/nginx/conf.d/studio-panel-ssl.conf
panel_ready=0
if [[ -s "/etc/letsencrypt/live/$PANEL_HOSTNAME/fullchain.pem" && -f "$panel_conf" ]] \
  && grep -Fq "server_name $PANEL_HOSTNAME;" "$panel_conf" \
  && grep -Fq 'listen 443 ssl;' "$panel_conf"; then
  panel_ready=1
fi
if (( !panel_ready )); then
  if points_here "$PANEL_HOSTNAME"; then
    "$PROJECT_ROOT/ops/scripts/panel-ssl.sh" "$PANEL_HOSTNAME" || failed=1
  else
    echo "Panel sertifikası DNS kaydı bekliyor: $PANEL_HOSTNAME"
  fi
else
  "$PROJECT_ROOT/ops/scripts/panel-ip-redirect.sh" || failed=1
fi

if [[ ! -f "/etc/letsencrypt/live/$MAIL_HOSTNAME/fullchain.pem" ]]; then
  if points_here "$MAIL_HOSTNAME"; then
    "$PROJECT_ROOT/ops/scripts/mail-ssl.sh" "${MAIL_HOSTNAME#mail.}" || failed=1
  else
    echo "Posta sertifikası DNS kaydı bekliyor: $MAIL_HOSTNAME"
  fi
fi
exit "$failed"
