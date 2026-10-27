#!/usr/bin/env bash
# ops/scripts/remove-vhost.sh <domain>
#
# deploy-vhost.sh'in tersi: domain silinirken /etc/nginx/conf.d/<domain>.conf
# (ve varsa .bak.* yedekleri) kaldırır. Olmadan domain silme, canlı nginx'te
# yetim bir server bloğu bırakıyordu (bkz. apps/api/src/routes/domains.ts
# DELETE /api/domains/:id). Gerçek nginx `proxy-server` container'ında
# çalıştığı için (bkz. deploy-vhost.sh notu) silme sonrası orada da reload
# tetiklenir.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanım: $0 <domain>"
DOMAIN="$1"

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Geçersiz domain adı: $DOMAIN"

rm -f "/etc/nginx/conf.d/${DOMAIN}.conf" "/etc/nginx/conf.d/${DOMAIN}.conf".bak.*
docker exec proxy-server nginx -s reload
echo "✓ /etc/nginx/conf.d/${DOMAIN}.conf kaldırıldı (varsa) ve proxy-server reload edildi."
