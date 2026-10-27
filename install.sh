#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_SCRIPT_ROOT=/var/www/vhosts/studio-panel
cd "$ROOT"
err() { printf 'HATA: %s\n' "$*" >&2; exit 1; }
say() { printf '\n» %s\n' "$*"; }
# shellcheck disable=SC1091
source "$ROOT/host-packages.sh"
detect_host_os || exit 1
if [[ "${1:-}" == --check-os && $# -eq 1 ]]; then
  say "Desteklenen sistem: ${PRETTY_NAME:-bilinmiyor} ($PANEL_PACKAGE_MANAGER, Docker $PANEL_DOCKER_REPO deposu)"
  exit 0
fi
[[ $# -eq 0 ]] || err "Kullanım: bash install.sh [--check-os]"
[[ $EUID -eq 0 ]] || err "Kurulum root ile çalışmalı: sudo bash install.sh"
[[ -r /dev/tty ]] || err "İsimleri ve parolayı sormak için etkileşimli terminal gerekli."
[[ ! -f "$ROOT/.env" ]] || err "Bu dizinde kurulum ayarları zaten var. Mevcut verileri korumak için yeniden kurulum durduruldu."
cpu=$(nproc)
mem_kib=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
disk_gib=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
(( cpu >= 2 )) || err "En az 2 CPU gerekli."
(( mem_kib >= 3500000 )) || err "En az 4 GB RAM sınıfı gerekli."
(( disk_gib >= 25 )) || err "En az 25 GB boş disk gerekli (40 GB VDS önerilir)."

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
valid_panel_name() { [[ "$1" =~ ^[[:alnum:][:space:]_-]{2,60}$ ]]; }
valid_container_name() { [[ "$1" =~ ^[a-z][a-z0-9_-]{1,49}$ ]]; }
valid_shell_user() {
  [[ "$1" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || return 1
  case "$1" in
    root|daemon|bin|sys|sync|mail|ftp|www-data|mysql|postgres|redis|named|opendkim|postfix|dovecot|docker|nobody) return 1;;
  esac
}
valid_domain() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || return 1
  case "${1,,}" in example.com|*.example.com|*.example|*.invalid|*.test|*.localhost) return 1;; esac
}
valid_panel_host() { [[ "$1" == yok ]] || valid_domain "$1"; }
valid_optional_domain() { [[ -z "$1" ]] || valid_domain "$1"; }
valid_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
valid_admin_user() { [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_-]{2,31}$ ]]; }
valid_ipv4() {
  local a b c d octet
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r a b c d <<< "$1"
  for octet in "$a" "$b" "$c" "$d"; do (( 10#$octet <= 255 )) || return 1; done
}

ask_valid panel_name 'Panelde görünecek ad' 'Studio Panel' valid_panel_name '2-60 karakter; harf, rakam, boşluk, _ veya - kullan.'
ask_valid container_name 'Docker konteyner adı' 'core-panel' valid_container_name 'Küçük harfle başla; yalnız a-z, 0-9, _ veya - kullan.'
ask_valid shell_user 'Konteyner kullanıcı adı (yalnız ad; su komutunu yazma)' 'devuser' valid_shell_user 'Küçük harfle başla; yalnız a-z, 0-9, _ veya - kullan ve servis adlarından kaçın.'
ask_valid panel_host 'Panel alan adı (henüz yoksa yok yaz)' 'yok' valid_panel_host 'Gerçek bir alan adı veya yok yaz.'
domain_pending=0
if [[ "$panel_host" == yok ]]; then
  domain_pending=1
  panel_host=panel.invalid
  mail_domain=panel.invalid
  dns_primary_ns=ns1.panel.invalid
  dns_secondary_ns=''
  say "Alan adı olmadan kurulum: panel IP üzerinden HTTP ile açılacak. SSL ve gerçek e-posta alan adı daha sonra etkinleşir."
else
  ask_valid mail_domain 'Posta alanı (mail.<alan> kullanılacak)' '' valid_domain 'Sahip olduğun gerçek alan adını gir.'
  ask_valid dns_primary_ns 'Yetkili DNS sunucu adı' "ns1.$mail_domain" valid_domain 'Geçerli bir DNS sunucu adı gir.'
  ask_valid dns_secondary_ns 'İkinci DNS sunucu adı (yoksa boş bırak)' '' valid_optional_domain 'Geçerli bir DNS sunucu adı gir veya boş bırak.'
fi
if (( domain_pending )); then
  ask_valid admin_email 'Yönetici giriş e-posta adresi (kullandığın gerçek bir adres)' '' valid_email 'Geçerli bir e-posta adresi gir.'
else
  ask_valid admin_email 'Yönetici giriş e-posta adresi' "admin@$mail_domain" valid_email 'Geçerli bir e-posta adresi gir.'
fi
ask_valid admin_user 'Yönetici kullanıcı adı' 'admin' valid_admin_user '3-32 karakterlik bir kullanıcı adı gir.'
while :; do
  read -r -s -p 'Yönetici parolası: ' admin_password </dev/tty || err "Giriş iptal edildi."
  printf '\n'
  if [[ -z "$admin_password" ]]; then printf 'Parola boş olamaz. Tekrar dene.\n' >&2; continue; fi
  read -r -s -p 'Parolayı tekrar gir: ' password_again </dev/tty || err "Giriş iptal edildi."
  printf '\n'
  if [[ "$admin_password" == "$password_again" ]]; then break; fi
  printf 'Parolalar eşleşmiyor. Tekrar dene.\n' >&2
done
unset password_again

public_ip=""
if command -v curl >/dev/null 2>&1; then public_ip=$(curl -4fsS --max-time 5 https://api.ipify.org || true); fi
[[ "$public_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || public_ip=""
ask_valid public_ip 'VDS genel IPv4 adresi' "$public_ip" valid_ipv4 'Geçerli bir IPv4 adresi gir.'

say "Docker Engine kuruluyor"
install_host_tools
for port in 21 25 80 443 465 587 993 995; do
  if ss -H -ltnu "sport = :$port" 2>/dev/null | grep -q .; then err "$port portu kullanımda. Boş VDS gerekli."; fi
done
if ss -H -ltnu 'sport = :53' 2>/dev/null | awk -v ip="$public_ip" '$5 == "0.0.0.0:53" || $5 == ip ":53" || $5 == "*:53" || $5 == "[::]:53" { conflict=1 } END { exit !conflict }'; then
  err "Genel IP üzerindeki 53 portu kullanımda."
fi
ip -4 -o addr show | awk '{split($4,a,"/"); print a[1]}' | grep -Fxq "$public_ip" \
  || err "Genel IP ($public_ip) VDS ağ arayüzünde yok. DNS 53 portunu güvenle bağlamak için doğrudan IP atanmış VDS gerekli."
install_host_docker
systemctl enable --now docker
docker compose version >/dev/null || err "Docker Compose eklentisi eksik."

# A 4 GB machine can build Next.js while preserving room for PostgreSQL.
# Keep swap on the same disk, sized to the small-VDS profile.
if [[ ! -s /proc/swaps || $(wc -l </proc/swaps) -le 1 ]]; then
  if [[ ! -f /swapfile-panel ]]; then
    fallocate -l 2G /swapfile-panel
    chmod 0600 /swapfile-panel
    mkswap /swapfile-panel >/dev/null
  fi
  swapon /swapfile-panel || true
  grep -q '^/swapfile-panel ' /etc/fstab || printf '/swapfile-panel none swap sw 0 0\n' >> /etc/fstab
fi

session_secret=$(openssl rand -hex 48)
pg_password=$(openssl rand -hex 24)
mysql_password=$(openssl rand -hex 24)
umask 077
cat > "$ROOT/.env" <<EOF
PANEL_DISPLAY_NAME=$panel_name
PANEL_CONTAINER_NAME=$container_name
PANEL_SHELL_USER=$shell_user
PANEL_HOSTNAME=$panel_host
MAIL_HOSTNAME=mail.$mail_domain
PANEL_DOMAIN_PENDING=$domain_pending
DNS_PRIMARY_NS=$dns_primary_ns
DNS_SECONDARY_NS=$dns_secondary_ns
DNS_HOSTMASTER_EMAIL=hostmaster@$mail_domain
SERVER_PUBLIC_IP=$public_ip
PANEL_OWNER_EMAIL=$admin_email
STUDIO_PG_USER=studio
STUDIO_PG_PASSWORD=$pg_password
STUDIO_PG_DATABASE=studio_panel
MYSQL_ADMIN_USER=panel_admin
MYSQL_ADMIN_PASSWORD=$mysql_password
DATABASE_URL=postgres://studio:$pg_password@127.0.0.1:5433/studio_panel
SESSION_SECRET=$session_secret
EOF
chmod 0600 "$ROOT/.env"
mkdir -p "$ROOT/data/docker" "$ROOT/data/vhosts" "$ROOT/data/state"
chmod 0700 "$ROOT/data"

say "Panel imajı oluşturuluyor (ilk kurulum birkaç dakika sürebilir)"
docker compose --env-file "$ROOT/.env" build
docker compose --env-file "$ROOT/.env" up -d

say "Veritabanı şeması ve servislerin açılması bekleniyor"
ready=0
for _ in {1..180}; do
  if docker exec "$container_name" sh -c 'test -f /var/www/vhosts/studio-panel/ops/run/.installer-ready' >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if (( ready == 0 )); then
  docker logs --tail 80 "$container_name" >&2 || true
  err "İlk açılış tamamlanamadı. Parola bellekte tutulmadı; günlükleri incele."
fi
printf '%s\n' "$admin_password" | docker exec -i -w "$PANEL_SCRIPT_ROOT" "$container_name" \
  node ops/scripts/seed-admin.mjs "$admin_email" "$admin_user"
unset admin_password session_secret pg_password mysql_password

# Certificate issuance requires public DNS and port 80 reachability.
if (( domain_pending )); then
  say "Alan adı daha sonra eklenebilir: sudo bash $ROOT/configure-domain.sh"
else
  panel_a=$(getent ahostsv4 "$panel_host" 2>/dev/null | awk 'NR==1 {print $1}')
  mail_a=$(getent ahostsv4 "mail.$mail_domain" 2>/dev/null | awk 'NR==1 {print $1}')
  if [[ "$panel_a" == "$public_ip" ]]; then
    say "Panel TLS sertifikası alınıyor"
    docker exec "$container_name" "$PANEL_SCRIPT_ROOT/ops/scripts/panel-ssl.sh" "$panel_host" || true
  else
    say "Panel DNS henüz $public_ip adresine yönelmiyor; TLS sertifikası beklemede."
  fi
  if [[ "$mail_a" == "$public_ip" ]]; then
    say "Posta TLS sertifikası alınıyor"
    docker exec "$container_name" "$PANEL_SCRIPT_ROOT/ops/scripts/mail-ssl.sh" "$mail_domain" || true
  else
    say "mail.$mail_domain DNS henüz $public_ip adresine yönelmiyor; posta TLS sertifikası beklemede."
  fi
fi

say "Kurulum tamamlandı. Servisleri kontrol et: docker exec -it $container_name sh"
if (( domain_pending )); then
  printf 'Panel: http://%s (alan adı ve HTTPS henüz yok)\n' "$public_ip"
else
  printf 'Panel: https://%s (sertifika için DNS gerekli)\n' "$panel_host"
fi
printf 'Yedekler: %s/data/vhosts/studio-panel/ops/backups\n' "$ROOT"
