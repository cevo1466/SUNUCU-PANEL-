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
  read -r -p "$prompt [$default]: " answer </dev/tty
  printf -v "$__name" '%s' "${answer:-$default}"
}
ask panel_name 'Panelde görünecek ad' 'Studio Panel'
[[ "$panel_name" =~ ^[[:alnum:][:space:]_-]{2,60}$ ]] || err "Panel adı harf, rakam, boşluk, _ veya - içermeli."
ask container_name 'Docker konteyner adı' 'core-panel'
[[ "$container_name" =~ ^[a-z][a-z0-9_-]{1,49}$ ]] || err "Konteyner adı küçük harfle başlamalı, yalnız a-z 0-9 _ - içermeli."
ask shell_user 'Konteyner içindeki kullanıcı adı (su - ile giriş)' 'devuser'
[[ "$shell_user" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || err "Kullanıcı adı küçük harfle başlamalı, yalnız a-z 0-9 _ - içermeli."
case "$shell_user" in
  root|daemon|bin|sys|sync|mail|ftp|www-data|mysql|postgres|redis|named|opendkim|postfix|dovecot|docker|nobody)
    err "Bu kullanıcı adı sistem servisi tarafından kullanılıyor; başka ad seç."
    ;;
esac
ask panel_host 'Panel alan adı (henüz yoksa yok yaz)' 'yok'
domain_pending=0
if [[ "$panel_host" == yok ]]; then
  domain_pending=1
  panel_host=panel.invalid
  mail_domain=panel.invalid
  dns_primary_ns=ns1.panel.invalid
  dns_secondary_ns=''
  say "Alan adı olmadan kurulum: panel IP üzerinden HTTP ile açılacak. SSL ve gerçek e-posta alan adı daha sonra etkinleşir."
else
  [[ "$panel_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || err "Geçerli bir panel alan adı gir."
  ask mail_domain 'Posta alanı (mail.<alan> kullanılacak)' 'example.com'
  [[ "$mail_domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || err "Geçerli bir posta alanı gir."
  ask dns_primary_ns 'Yetkili DNS sunucu adı' "ns1.$mail_domain"
  [[ "$dns_primary_ns" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || err "Geçerli bir DNS sunucu adı gir."
  ask dns_secondary_ns 'İkinci DNS sunucu adı (yoksa boş bırak)' ''
  [[ -z "$dns_secondary_ns" || "$dns_secondary_ns" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || err "Geçerli bir ikinci DNS sunucu adı gir."
fi
if (( domain_pending )); then
  ask admin_email 'Yönetici giriş e-posta adresi (kullandığın gerçek bir adres)' ''
else
  ask admin_email 'Yönetici giriş e-posta adresi' "admin@$mail_domain"
fi
[[ "$admin_email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || err "Geçerli bir e-posta adresi gir."
ask admin_user 'Yönetici kullanıcı adı' 'admin'
[[ "$admin_user" =~ ^[A-Za-z][A-Za-z0-9_-]{2,31}$ ]] || err "Yönetici adı 3-32 karakter olmalı."
read -r -s -p 'Yönetici parolası (en az 16 karakter): ' admin_password </dev/tty; printf '\n'
(( ${#admin_password} >= 16 )) || err "Parola en az 16 karakter olmalı."
read -r -s -p 'Parolayı tekrar gir: ' password_again </dev/tty; printf '\n'
[[ "$admin_password" == "$password_again" ]] || err "Parolalar eşleşmiyor."
unset password_again

public_ip=""
if command -v curl >/dev/null 2>&1; then public_ip=$(curl -4fsS --max-time 5 https://api.ipify.org || true); fi
[[ "$public_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || public_ip=""
ask public_ip 'VDS genel IPv4 adresi' "$public_ip"
[[ "$public_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || err "Geçerli bir IPv4 adresi gir."
IFS=. read -r ip1 ip2 ip3 ip4 <<< "$public_ip"
for octet in "$ip1" "$ip2" "$ip3" "$ip4"; do (( 10#$octet <= 255 )) || err "Geçerli bir IPv4 adresi gir."; done

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
