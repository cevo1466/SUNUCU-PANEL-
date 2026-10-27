#!/usr/bin/env bash
# Add a real panel/mail domain to a domainless installation without deleting data.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"
err() { printf 'HATA: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || err "root gerekli: sudo bash $0"
[[ -r /dev/tty ]] || err "Etkileşimli terminal gerekli."
[[ -f "$ENV_FILE" ]] || err "Önce panel kurulmalı: $ENV_FILE yok."
grep -qx 'PANEL_DOMAIN_PENDING=1' "$ENV_FILE" || err "Bu kurulum alan adı bekleyen modda değil."

ask() {
  local __name="$1" prompt="$2" default="$3" answer
  read -r -p "$prompt [$default]: " answer </dev/tty || err "Giriş iptal edildi."
  printf -v "$__name" '%s' "${answer:-$default}"
}
ask_valid() {
  local __name="$1" prompt="$2" default="$3" validator="$4" message="$5"
  while :; do
    ask "$__name" "$prompt" "$default"
    if "$validator" "${!__name}"; then return 0; fi
    printf 'Geçersiz giriş: %s Tekrar dene.\n' "$message" >&2
  done
}
valid_domain() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || return 1
  case "${1,,}" in example.com|*.example.com|*.example|*.invalid|*.test|*.localhost) return 1;; esac
}
valid_optional_domain() { [[ -z "$1" ]] || valid_domain "$1"; }

ask_valid panel_host 'Panel alan adı' '' valid_domain 'Sahip olduğun gerçek bir panel alan adı gir.'
ask_valid mail_domain 'Posta alanı' '' valid_domain 'Sahip olduğun gerçek bir posta alanı gir.'
ask_valid dns_primary_ns 'Yetkili DNS sunucu adı' "ns1.$mail_domain" valid_domain 'Geçerli bir DNS sunucu adı gir.'
ask_valid dns_secondary_ns 'İkinci DNS sunucu adı (yoksa boş bırak)' '' valid_optional_domain 'Geçerli bir DNS sunucu adı gir veya boş bırak.'

container_name=$(sed -n 's/^PANEL_CONTAINER_NAME=//p' "$ENV_FILE" | head -1)
public_ip=$(sed -n 's/^SERVER_PUBLIC_IP=//p' "$ENV_FILE" | head -1)
[[ -n "$container_name" && -n "$public_ip" ]] || err "Mevcut kurulum ayarları eksik."

tmp=$(mktemp "$ROOT/.env.domain.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp "$ENV_FILE" "$tmp"
replace() { sed -i "s|^$1=.*|$1=$2|" "$tmp"; }
replace PANEL_HOSTNAME "$panel_host"
replace MAIL_HOSTNAME "mail.$mail_domain"
replace DNS_PRIMARY_NS "$dns_primary_ns"
replace DNS_SECONDARY_NS "$dns_secondary_ns"
replace DNS_HOSTMASTER_EMAIL "hostmaster@$mail_domain"
replace PANEL_DOMAIN_PENDING 0
docker compose --env-file "$tmp" -f "$ROOT/compose.yaml" config -q
chmod 0600 "$tmp"
mv "$tmp" "$ENV_FILE"

docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.yaml" up -d --force-recreate
ready=0
for _ in {1..120}; do
  if docker exec "$container_name" curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
(( ready )) || err "Konteyner henüz hazır değil. docker logs --tail 100 $container_name ile incele; veriler korundu."
docker exec "$container_name" /var/www/vhosts/studio-panel/ops/scripts/ssl-bootstrap.sh \
  || printf 'SSL denemesi tamamlanmadı; A kayıtları ve 80 portu hazır olunca zamanlayıcı tekrar deneyecek.\n' >&2

printf 'Alan adları kaydedildi. Panel A kaydı: %s -> %s\n' "$panel_host" "$public_ip"
printf 'Posta A kaydı: mail.%s -> %s\n' "$mail_domain" "$public_ip"
printf 'DNS ve SSL hazır olana kadar panel IP üzerinden HTTP ile açılır: http://%s\n' "$public_ip"
