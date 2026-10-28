#!/usr/bin/env bash
# Change an existing installation to panel.<base-domain> without reinstalling.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
err() { printf 'HATA: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || err "root gerekli: sudo bash $0"
[[ -r /dev/tty ]] || err "Etkileşimli terminal gerekli."
[[ -f .env ]] || err "Kurulu panel ayarları bulunamadı."
grep -qx 'PANEL_DOMAIN_PENDING=0' .env || err "Alan adı bekleyen kurulumda configure-domain.sh kullan."

valid_domain() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || return 1
  case "${1,,}" in example.com|*.example.com|*.example|*.invalid|*.test|*.localhost) return 1;; esac
}
mail_host=$(sed -n 's/^MAIL_HOSTNAME=//p' .env | head -1)
default_domain=${mail_host#mail.}
valid_domain "$default_domain" || default_domain=''
while :; do
  read -r -p "Ana alan adı [$default_domain]: " answer </dev/tty || err "Giriş iptal edildi."
  base_domain=${answer:-$default_domain}
  if valid_domain "$base_domain"; then break; fi
  printf 'Geçerli bir ana alan adı gir.\n' >&2
done
panel_host="panel.$base_domain"
container_name=$(sed -n 's/^PANEL_CONTAINER_NAME=//p' .env | head -1)
[[ "$container_name" =~ ^[a-z][a-z0-9_-]{1,49}$ ]] || err "Konteyner adı geçersiz."

if docker exec "$container_name" test -f "/etc/nginx/conf.d/$panel_host.conf"; then
  err "$panel_host bir web sitesi olarak Nginx'te yayında. Panel adresiyle çakışır. Önce sitenin Nginx yayınını kaldır; site dosyalarını silme."
fi

old_env=$(mktemp "$ROOT/.env.before-panel-host.XXXXXX")
new_env=$(mktemp "$ROOT/.env.new-panel-host.XXXXXX")
cp -p .env "$old_env"
cp -p .env "$new_env"
chmod 0600 "$old_env" "$new_env"
changed=0
rollback() {
  local status=$?
  trap - EXIT
  if (( changed && status != 0 )); then
    printf 'Panel adresi güncellenemedi; önceki ayarlar geri yükleniyor.\n' >&2
    cp -p "$old_env" .env
    docker compose --env-file .env up -d --no-build --force-recreate || true
  fi
  rm -f "$old_env" "$new_env"
  exit "$status"
}
trap rollback EXIT
sed -i "s|^PANEL_HOSTNAME=.*|PANEL_HOSTNAME=$panel_host|" "$new_env"
docker compose --env-file "$new_env" config -q
old_host=$(sed -n 's/^PANEL_HOSTNAME=//p' .env | head -1)
if [[ "$old_host" != "$panel_host" ]]; then
  mv -f "$new_env" .env
  changed=1
  docker compose --env-file .env up -d --no-build --force-recreate
  ready=0
  for _ in {1..120}; do
    if docker exec "$container_name" curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  (( ready )) || err "Panel sağlık kontrolü başarısız."
fi
changed=0
docker exec "$container_name" /var/www/vhosts/studio-panel/ops/scripts/ssl-bootstrap.sh \
  || printf 'SSL henüz tamamlanmadı; DNS/80 portu hazır olunca zamanlayıcı yeniden deneyecek.\n' >&2
if docker exec "$container_name" sh -c \
  'test -s "/etc/letsencrypt/live/$PANEL_HOSTNAME/fullchain.pem" && test -f /etc/nginx/conf.d/studio-panel-ip-redirect.conf' >/dev/null 2>&1; then
  printf '✓ Panel: https://%s; http://SUNUCU_IP -> HTTPS 301\n' "$panel_host"
else
  printf 'Panel adresi kaydedildi: %s. A kaydını VDS IP adresine yönlendir; HTTPS otomatik denenecek.\n' "$panel_host"
fi
