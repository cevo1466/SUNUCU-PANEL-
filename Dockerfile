FROM docker:29.8.0-dind-alpine3.24

RUN apk add --no-cache \
    bash bind bind-tools certbot cronie curl dovecot dovecot-lmtpd dovecot-pop3d \
    mariadb mariadb-client net-tools nodejs npm opendkim openssl \
    php84 php84-fpm php84-mbstring php84-mysqli php84-openssl php84-pdo \
    php84-pdo_mysql php84-pdo_pgsql php84-pgsql php84-phar php84-session \
    postfix postgresql16 postgresql16-client pure-ftpd redis rsync sudo \
    tzdata unzip util-linux
RUN if ! command -v php >/dev/null 2>&1; then ln -s /usr/bin/php84 /usr/bin/php; fi

ARG PANEL_SHELL_USER=devuser
ENV PANEL_SHELL_USER="${PANEL_SHELL_USER}"
RUN addgroup -g 1001 "$PANEL_SHELL_USER" \
    && adduser -D -u 1001 -G "$PANEL_SHELL_USER" -h "/home/$PANEL_SHELL_USER" -s /bin/sh "$PANEL_SHELL_USER" \
    && addgroup "$PANEL_SHELL_USER" docker \
    && printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$PANEL_SHELL_USER" > "/etc/sudoers.d/$PANEL_SHELL_USER" \
    && chmod 0440 "/etc/sudoers.d/$PANEL_SHELL_USER" \
    && printf '%s\n' 'if [ -r /var/www/vhosts/studio-panel/.env.loopkit ]; then set -a; . /var/www/vhosts/studio-panel/.env.loopkit; set +a; fi' >> "/home/$PANEL_SHELL_USER/.profile" \
    && mkdir -p /opt/panel-template /etc/opendkim

WORKDIR /opt/panel-template
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY ops ./ops
RUN find apps packages ops -type f \( -name '*.sh' -o -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.sql' -o -name '*.php' \) \
      -exec sed -i "s/devuser/${PANEL_SHELL_USER}/g" {} + \
    && npm ci --no-audit --no-fund \
    && npm run build --workspace=apps/api

ARG PANEL_DISPLAY_NAME="Studio Panel"
ENV PANEL_DISPLAY_NAME="${PANEL_DISPLAY_NAME}" \
    NEXT_PUBLIC_PANEL_DISPLAY_NAME="${PANEL_DISPLAY_NAME}" \
    NEXT_TELEMETRY_DISABLED=1 \
    DOCKER_TLS_CERTDIR=""
RUN npm run build --workspace=apps/web \
    && mkdir -p /opt/panel-config-defaults \
    && cp -a /etc/postfix /etc/dovecot /etc/bind /etc/opendkim /opt/panel-config-defaults/ \
    && chmod +x /opt/panel-template/ops/scripts/*.sh \
    && /opt/panel-template/ops/scripts/install-adminer.sh

COPY deploy/container-init.sh /usr/local/sbin/panel-container-init
RUN chmod 0755 /usr/local/sbin/panel-container-init

ENTRYPOINT ["/usr/local/sbin/panel-container-init"]
