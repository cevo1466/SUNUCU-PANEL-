#!/usr/bin/env bash
# Redirect only the server's HTTP IPv4 address after panel HTTPS is ready.
set -Eeuo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'HATA: root gerekli' >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env.loopkit"
[[ "${PANEL_DOMAIN_PENDING:-0}" != 1 ]] || exit 0
[[ "${SERVER_PUBLIC_IP:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'HATA: Genel IPv4 geçersiz' >&2; exit 1; }
[[ "${PANEL_HOSTNAME:-}" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo 'HATA: Panel alan adı geçersiz' >&2; exit 1; }

SSL_CONF=/etc/nginx/conf.d/studio-panel-ssl.conf
IP_CONF=/etc/nginx/conf.d/studio-panel-ip-redirect.conf
[[ -s "/etc/letsencrypt/live/$PANEL_HOSTNAME/fullchain.pem" ]] || { echo 'HATA: Panel sertifikası hazır değil' >&2; exit 1; }
[[ -f "$SSL_CONF" ]] && grep -Fq "server_name $PANEL_HOSTNAME;" "$SSL_CONF" \
  && grep -Fq 'listen 443 ssl;' "$SSL_CONF" \
  || { echo 'HATA: Panel HTTPS Nginx ayarı hazır değil' >&2; exit 1; }

tmp=$(mktemp "$IP_CONF.tmp.XXXXXX")
old=$(mktemp)
had_old=0
trap 'rm -f "$tmp" "$old"' EXIT
cat > "$tmp" <<EOF
# panel-ip-redirect: $SERVER_PUBLIC_IP -> https://$PANEL_HOSTNAME
server {
    listen 80;
    server_name $SERVER_PUBLIC_IP;
    return 301 https://$PANEL_HOSTNAME\$request_uri;
}
EOF
if [[ -f "$IP_CONF" ]] && cmp -s "$tmp" "$IP_CONF"; then exit 0; fi
if [[ -f "$IP_CONF" ]]; then cp -p "$IP_CONF" "$old"; had_old=1; fi
chmod 0644 "$tmp"
mv -f "$tmp" "$IP_CONF"
if ! docker exec proxy-server nginx -t; then
  if (( had_old )); then cp -p "$old" "$IP_CONF"; else rm -f "$IP_CONF"; fi
  echo 'HATA: IP yönlendirmesi Nginx doğrulamasından geçmedi' >&2
  exit 1
fi
if ! docker exec proxy-server nginx -s reload; then
  if (( had_old )); then cp -p "$old" "$IP_CONF"; else rm -f "$IP_CONF"; fi
  docker exec proxy-server nginx -s reload || true
  echo 'HATA: IP yönlendirmesi etkinleştirilemedi' >&2
  exit 1
fi
printf '✓ http://%s -> https://%s (301)\n' "$SERVER_PUBLIC_IP" "$PANEL_HOSTNAME"
