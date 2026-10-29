#!/usr/bin/env bash
set -Eeuo pipefail

STATE=/var/lib/panel-state
PANEL=/var/www/vhosts/studio-panel
export HOME=/root

log() { printf '[panel] %s\n' "$*"; }
die() { printf '[panel] HATA: %s\n' "$*" >&2; exit 1; }
need() { [[ -n "${!1:-}" ]] || die "$1 eksik"; }
for key in PANEL_HOSTNAME MAIL_HOSTNAME SERVER_PUBLIC_IP PANEL_OWNER_EMAIL DATABASE_URL STUDIO_PG_PASSWORD SESSION_SECRET PANEL_SHELL_USER MYSQL_ADMIN_PASSWORD; do need "$key"; done

mkdir -p "$STATE" /var/www/vhosts /etc/nginx
# Domain creation runs as the panel account; the bind-mount root must be
# writable even when Docker created the host directory as root.
chown "$PANEL_SHELL_USER:$PANEL_SHELL_USER" /var/www/vhosts
if [[ ! -f "$PANEL/package.json" ]]; then
  mkdir -p "$PANEL"
  cp -a /opt/panel-template/. "$PANEL/"
  chown -R "$PANEL_SHELL_USER:$PANEL_SHELL_USER" "$PANEL"
  log "Temiz panel kodu kuruldu"
fi
mkdir -p "$PANEL/ops/generated" "$PANEL/ops/backups" "$PANEL/ops/run" /var/www/vhosts/_acme/.well-known/acme-challenge
chown "$PANEL_SHELL_USER:$PANEL_SHELL_USER" "$PANEL/ops" "$PANEL/ops/generated" "$PANEL/ops/backups" "$PANEL/ops/run" /var/www/vhosts/_acme

# Cron and helper scripts read this file. It is generated from Docker's
# environment and never copied into the image or Git repository.
umask 077
cat > "$PANEL/.env.loopkit" <<EOF
PANEL_DISPLAY_NAME="$PANEL_DISPLAY_NAME"
PANEL_OWNER_EMAIL=$PANEL_OWNER_EMAIL
PANEL_HOSTNAME=$PANEL_HOSTNAME
MAIL_HOSTNAME=$MAIL_HOSTNAME
PANEL_DOMAIN_PENDING=${PANEL_DOMAIN_PENDING:-0}
SERVER_PUBLIC_IP=$SERVER_PUBLIC_IP
DATABASE_URL=$DATABASE_URL
STUDIO_PG_USER=$STUDIO_PG_USER
STUDIO_PG_PASSWORD=$STUDIO_PG_PASSWORD
STUDIO_PG_DATABASE=$STUDIO_PG_DATABASE
SESSION_SECRET=$SESSION_SECRET
MYSQL_ADMIN_USER=$MYSQL_ADMIN_USER
MYSQL_ADMIN_PASSWORD=$MYSQL_ADMIN_PASSWORD
ALLOW_PUBLIC_REGISTRATION=false
ADMINER_URL=/adminer
DNS_PRIMARY_NS=${DNS_PRIMARY_NS:-}
DNS_SECONDARY_NS=${DNS_SECONDARY_NS:-}
DNS_HOSTMASTER_EMAIL=${DNS_HOSTMASTER_EMAIL:-}
EOF
write_optional_secret() {
  local name="$1" value="$2" escaped
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name satır sonu içeremez"
  escaped=${value//\'/\'\\\'\'}
  printf "%s='%s'\n" "$name" "$escaped" >> "$PANEL/.env.loopkit"
}
write_optional_secret CLOUDFLARE_API_TOKEN "${CLOUDFLARE_API_TOKEN:-}"
write_optional_secret HETRIX_API_KEY "${HETRIX_API_KEY:-}"
write_optional_secret TELEGRAM_BOT_TOKEN "${TELEGRAM_BOT_TOKEN:-}"
write_optional_secret TELEGRAM_CHAT_ID "${TELEGRAM_CHAT_ID:-}"
chown "$PANEL_SHELL_USER:$PANEL_SHELL_USER" "$PANEL/.env.loopkit"
chmod 0600 "$PANEL/.env.loopkit"

persist_dir() {
  local name="$1" dest="$2" template="${3:-}"
  if [[ ! -e "$STATE/$name/.ready" ]]; then
    mkdir -p "$STATE/$name"
    if [[ -n "$template" && -d "$template" ]]; then cp -a "$template/." "$STATE/$name/"; fi
    touch "$STATE/$name/.ready"
  fi
  rm -rf "$dest"
  ln -s "$STATE/$name" "$dest"
}
persist_dir postfix /etc/postfix /opt/panel-config-defaults/postfix
persist_dir dovecot /etc/dovecot /opt/panel-config-defaults/dovecot
persist_dir bind /etc/bind /opt/panel-config-defaults/bind
persist_dir opendkim /etc/opendkim /opt/panel-config-defaults/opendkim
persist_dir letsencrypt /etc/letsencrypt
persist_dir mysql /var/lib/mysql
persist_dir nginx-conf /etc/nginx/conf.d
persist_dir postfix-spool /var/spool/postfix /var/spool/postfix
persist_dir pure-ftpd /etc/pure-ftpd
chmod 0755 "$STATE" "$STATE/postfix" "$STATE/dovecot" "$STATE/opendkim" \
  "$STATE/nginx-conf" "$STATE/postfix-spool" "$STATE/pure-ftpd"
mkdir -p "$STATE/ssl" /var/bind /run/opendkim /var/run/named
chown mysql:mysql "$STATE/mysql"
chown named:named /var/bind /var/run/named
chown opendkim:opendkim /run/opendkim

if [[ ! -f "$STATE/ssl/mail-key.pem" ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 \
    -subj "/CN=$MAIL_HOSTNAME" \
    -keyout "$STATE/ssl/mail-key.pem" -out "$STATE/ssl/mail-cert.pem" >/dev/null 2>&1
fi
chmod 0600 "$STATE/ssl/mail-key.pem"
ln -sf "$STATE/ssl/mail-key.pem" /etc/ssl/private/mail-key.pem
ln -sf "$STATE/ssl/mail-cert.pem" /etc/ssl/private/mail-cert.pem
if [[ ! -f "$STATE/ssl/pure-ftpd.pem" ]]; then
  cat "$STATE/ssl/mail-cert.pem" "$STATE/ssl/mail-key.pem" > "$STATE/ssl/pure-ftpd.pem"
  chmod 0600 "$STATE/ssl/pure-ftpd.pem"
fi
ln -sf "$STATE/ssl/pure-ftpd.pem" /etc/ssl/private/pure-ftpd.pem

if [[ ! -f "$STATE/postfix/.panel-configured" ]]; then
  postconf -e "myhostname = $MAIL_HOSTNAME"
  postconf -e 'mydestination = localhost'
  postconf -e 'inet_protocols = ipv4'
  postconf -e 'mynetworks = 127.0.0.0/8, [::1]/128'
  postconf -e 'virtual_mailbox_base = /var/www/vhosts'
  postconf -e 'virtual_mailbox_domains = lmdb:/etc/postfix/vmailbox_domains'
  postconf -e 'virtual_transport = lmtp:unix:private/dovecot-lmtp'
  postconf -e 'smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination'
  postconf -e 'smtpd_sasl_type = dovecot'
  postconf -e 'smtpd_sasl_path = private/auth'
  postconf -e 'smtpd_sender_login_maps = regexp:/etc/postfix/sender_login.regexp'
  postconf -e 'smtpd_tls_cert_file = /etc/ssl/private/mail-cert.pem'
  postconf -e 'smtpd_tls_key_file = /etc/ssl/private/mail-key.pem'
  postconf -e 'smtpd_tls_security_level = may'
  postconf -e 'smtp_tls_security_level = may'
  postconf -e 'smtpd_milters = inet:localhost:8891'
  postconf -e 'non_smtpd_milters = inet:localhost:8891'
  postconf -e 'milter_default_action = accept'
  postconf -e 'milter_protocol = 6'
  touch /etc/postfix/sender_login.regexp /etc/postfix/vmailbox_domains
  postmap lmdb:/etc/postfix/vmailbox_domains
  cat >> /etc/postfix/master.cf <<'EOF'
submission inet n - n - - smtpd
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_sasl_type=dovecot
  -o smtpd_sasl_path=private/auth
  -o smtpd_sasl_security_options=noanonymous
smtps inet n - n - - smtpd
  -o smtpd_tls_wrappermode=yes
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
EOF
  touch "$STATE/postfix/.panel-configured"
fi
postconf -e "myhostname = $MAIL_HOSTNAME"

if [[ ! -f "$STATE/dovecot/.panel-configured" ]]; then
  cat > /etc/dovecot/dovecot.conf <<'EOF'
dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
protocols {
  imap = yes
  lmtp = yes
  pop3 = yes
}
mail_driver = maildir
mail_path = ~
mail_plugins = quota
namespace inbox {
  inbox = yes
  separator = /
}
passdb passwd-file {
  passwd_file_path = /etc/dovecot/passwd
}
userdb passwd-file {
  passwd_file_path = /etc/dovecot/passwd
}
protocol imap {
  mail_plugins = quota imap_quota
}
quota "User quota" {
  driver = maildir
  storage_grace = 0
}
ssl_server {
  cert_file = /etc/ssl/private/mail-cert.pem
  key_file = /etc/ssl/private/mail-key.pem
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    group = postfix
    mode = 0660
    user = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    group = postfix
    mode = 0660
    user = postfix
  }
}
EOF
  touch /etc/dovecot/passwd "$STATE/dovecot/.panel-configured"
  chown root:dovecot /etc/dovecot/passwd
  chmod 0640 /etc/dovecot/passwd
fi

if [[ ! -f "$STATE/opendkim/.panel-configured" ]]; then
  cat > /etc/opendkim/opendkim.conf <<'EOF'
BaseDirectory /run/opendkim
PidFile /run/opendkim/opendkim.pid
Syslog yes
Canonicalization relaxed/simple
Mode sv
UMask 002
KeyTable /etc/opendkim/KeyTable
SigningTable refile:/etc/opendkim/SigningTable
Socket inet:8891@localhost
EOF
  touch /etc/opendkim/KeyTable /etc/opendkim/SigningTable "$STATE/opendkim/.panel-configured"
  chown root:opendkim /etc/opendkim/KeyTable /etc/opendkim/SigningTable
  chmod 0640 /etc/opendkim/KeyTable /etc/opendkim/SigningTable
fi

if [[ ! -f "$STATE/bind/.panel-configured" ]]; then
  rndc-confgen -a -c /etc/bind/rndc.key >/dev/null
  cat > /etc/bind/named.conf <<'EOF'
options {
  directory "/var/bind";
  listen-on { any; };
  listen-on-v6 { none; };
  allow-transfer { none; };
  pid-file "/var/run/named/named.pid";
  allow-recursion { none; };
  recursion no;
};
include "/etc/bind/rndc.key";
controls {
  inet 127.0.0.1 port 953 allow { 127.0.0.1; } keys { "rndc-key"; };
};
include "/etc/bind/named.conf.local";
EOF
  touch /etc/bind/named.conf.local "$STATE/bind/.panel-configured"
  mkdir -p /etc/bind/zones
fi
chown root:named /etc/bind/named.conf /etc/bind/named.conf.local /etc/bind/rndc.key
chmod 0640 /etc/bind/named.conf /etc/bind/named.conf.local /etc/bind/rndc.key
chmod 0751 /etc/bind /etc/bind/zones

if [[ ! -f /etc/php84/php-fpm.d/studio-panel.conf ]]; then
  rm -f /etc/php84/php-fpm.d/www.conf
  cat > /etc/php84/php-fpm.d/studio-panel.conf <<EOF
[studio-panel]
user = $PANEL_SHELL_USER
group = $PANEL_SHELL_USER
listen = 172.19.0.1:9000
listen.allowed_clients = 172.19.0.2,127.0.0.1
pm = dynamic
pm.max_children = 4
pm.start_servers = 1
pm.min_spare_servers = 1
pm.max_spare_servers = 2
pm.max_requests = 500
EOF
fi

if [[ ! -d "$STATE/mysql/mysql" ]]; then mariadb-install-db --user=mysql --datadir=/var/lib/mysql >/dev/null; fi
if ! redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
  redis-server --daemonize yes --bind 127.0.0.1 --maxmemory 128mb --maxmemory-policy allkeys-lru
fi
if ! mysqladmin ping >/dev/null 2>&1; then
  mysqld_safe --user=mysql --datadir=/var/lib/mysql --bind-address=127.0.0.1 \
    --skip-networking=0 --port=3306 > "$STATE/mariadb-start.log" 2>&1 &
  for i in {1..60}; do mysqladmin ping >/dev/null 2>&1 && break; sleep 1; done
fi
mysqladmin ping >/dev/null 2>&1 || die "MariaDB açılamadı"
for i in {1..30}; do
  if mysqladmin --protocol=tcp -h 127.0.0.1 ping >/dev/null 2>&1; then break; fi
  sleep 1
done
mysqladmin --protocol=tcp -h 127.0.0.1 ping >/dev/null 2>&1 || die "MariaDB TCP 3306 açılmadı"
mysql -uroot <<EOF
CREATE USER IF NOT EXISTS 'panel_admin'@'localhost' IDENTIFIED BY '$MYSQL_ADMIN_PASSWORD';
ALTER USER 'panel_admin'@'localhost' IDENTIFIED BY '$MYSQL_ADMIN_PASSWORD';
GRANT ALL PRIVILEGES ON *.* TO 'panel_admin'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
EOF
touch "$PANEL/ops/generated/pureftpd.passwd"
if [[ ! -f /etc/pure-ftpd/pureftpd.pdb ]]; then pure-pw mkdb /etc/pure-ftpd/pureftpd.pdb -f "$PANEL/ops/generated/pureftpd.passwd" || true; fi

if [[ ! -f /etc/nginx/conf.d/studio-panel.conf ]]; then
  cat > /etc/nginx/conf.d/studio-panel.conf <<'EOF'
server {
  listen 80 default_server;
  server_name _;
  client_max_body_size 2048m;
  location ^~ /.well-known/acme-challenge/ { root /var/www/vhosts/_acme; }
  location /api/ {
    proxy_pass http://172.19.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
  }
  location / {
    proxy_pass http://172.19.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
EOF
  cp "$PANEL/ops/nginx/catch-all.conf.example" /etc/nginx/conf.d/catch-all.conf
  cp "$PANEL/ops/nginx/webmail.conf.example" /etc/nginx/conf.d/webmail.conf
fi

log "İç Docker başlıyor"
dockerd --host=unix:///var/run/docker.sock > "$STATE/dockerd.log" 2>&1 &
docker_pid=$!
trap 'kill "$docker_pid" 2>/dev/null || true; wait "$docker_pid" 2>/dev/null || true' EXIT TERM INT
for i in {1..120}; do docker info >/dev/null 2>&1 && break; kill -0 "$docker_pid" || die "İç Docker açılmadı"; sleep 1; done
docker info >/dev/null 2>&1 || die "İç Docker zaman aşımı"
docker network inspect routing-net >/dev/null 2>&1 || docker network create --subnet 172.19.0.0/16 routing-net >/dev/null
if ! docker container inspect proxy-server >/dev/null 2>&1; then
  docker run -d --name proxy-server --restart unless-stopped --network routing-net --ip 172.19.0.2 \
    -p 80:80 -p 443:443 \
    -v /etc/nginx/conf.d:/etc/nginx/conf.d \
    -v /var/www/vhosts:/var/www/vhosts \
    nginx:alpine >/dev/null
else
  docker start proxy-server >/dev/null || true
fi
docker exec proxy-server nginx -t

# The inner proxy does not share /etc/letsencrypt with the outer container.
# Restore its certificate copies whenever it was recreated. live/ holds the
# Let's Encrypt certificates; custom/ holds paid-CA certificates installed from
# the panel (ops/scripts/ssl-custom.sh) and must be restored the same way, or
# nginx fails with "BIO_new_file() failed" for every domain that uses one.
if [[ -d /etc/letsencrypt/live || -d /etc/letsencrypt/custom ]]; then
  for cert_dir in /etc/letsencrypt/live/* /etc/letsencrypt/custom/*; do
    [[ -f "$cert_dir/fullchain.pem" && -f "$cert_dir/privkey.pem" ]] || continue
    docker exec proxy-server mkdir -p "$cert_dir"
    docker cp -L "$cert_dir/fullchain.pem" "proxy-server:$cert_dir/fullchain.pem"
    docker cp -L "$cert_dir/privkey.pem" "proxy-server:$cert_dir/privkey.pem"
  done
  docker exec proxy-server nginx -s reload || true
fi

cd "$PANEL"
log "PostgreSQL başlıyor ve şema kuruluyor"
setpriv --reuid=1001 --regid=1001 --init-groups -- env HOME="/home/$PANEL_SHELL_USER" npm run db:start
setpriv --reuid=1001 --regid=1001 --init-groups -- env HOME="/home/$PANEL_SHELL_USER" npm run db:migrate
setpriv --reuid=1001 --regid=1001 --init-groups -- env HOME="/home/$PANEL_SHELL_USER" ops/scripts/service.sh install-watchdog
setpriv --reuid=1001 --regid=1001 --init-groups -- env HOME="/home/$PANEL_SHELL_USER" ops/scripts/boot.sh
touch "$PANEL/ops/run/.installer-ready"
log "Panel servisleri başladı"
wait "$docker_pid"
