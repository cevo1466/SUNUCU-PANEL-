#!/usr/bin/env bash
# ops/scripts/deploy-vhost.sh <domain>
#
# Gerçek nginx bu container'da DEĞİL, ayrı bir Docker container'ında
# (`proxy-server`, nginx:alpine) çalışıyor — `docker ps` ile doğrulandı.
# `/etc/nginx/conf.d` iki container arasında bind-mount ile paylaşılıyor,
# bu yüzden dosyayı buraya kopyalamak yeterli; ama nginx'in bunu fark etmesi
# için o container İÇİNDE `nginx -s reload` çalıştırılmalı — bu container'daki
# `nginx` binary'si (varsa) proxy-server'ı etkilemez. Docker daemon'a erişim
# CLAUDE.md'nin varsayılan izolasyon kuralına istisna olarak kullanıcının
# açık onayıyla açıldı (bkz. Oturum notu, MEMORY.md 2026-08-27).
#
# guard.json'daki "Nginx vhost oluşturma/düzenleme" onay gerektiren işlemler
# listesindedir — BU YÜZDEN apps/api bu script'i SADECE sudoers'ta bu tek
# script'e (ve domain adı argümanına) tanımlanmış dar kapsamlı, şifresiz bir
# kural üzerinden çağırır (bkz. apps/api/src/routes/domains.ts
# `applyNginxConfig`, PROD-DEPLOYMENT.md). Script'in kendi domain-adı
# doğrulaması bu otomasyonun güvenlik sınırıdır — sudoers kuralı BAŞKA
# hiçbir komuta izin vermemelidir.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanım: $0 <domain>"
DOMAIN="$1"

# Aynı hostname doğrulaması apps/api/src/lib/domain.ts ile birebir —
# path-traversal veya kabuk enjeksiyonuna izin vermez.
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Geçersiz domain adı: $DOMAIN"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_CONF="$PROJECT_ROOT/ops/generated/${DOMAIN}.conf"
DEST_CONF="/etc/nginx/conf.d/${DOMAIN}.conf"

[ -f "$SRC_CONF" ] || fail "Üretilmiş config bulunamadı: $SRC_CONF (önce POST /api/domains/:id/nginx-config çağrılmalı)"

echo "» $SRC_CONF -> $DEST_CONF kopyalanıyor (önce .bak yedeği alınıyor)..."
if [ -f "$DEST_CONF" ]; then
  cp "$DEST_CONF" "${DEST_CONF}.bak.$(date +%s)"
fi
cp "$SRC_CONF" "$DEST_CONF"
chmod 0644 "$DEST_CONF"

echo "» proxy-server container'ında nginx -t doğrulanıyor..."
if ! docker exec proxy-server nginx -t 2>&1; then
  echo "✗ nginx -t BAŞARISIZ — $DEST_CONF geri alınıyor, reload YAPILMIYOR." >&2
  LAST_BAK="$(ls -t "${DEST_CONF}".bak.* 2>/dev/null | head -1 || true)"
  if [ -n "$LAST_BAK" ]; then
    cp "$LAST_BAK" "$DEST_CONF"
  else
    rm -f "$DEST_CONF"
  fi
  exit 1
fi

echo "» proxy-server container'ında nginx -s reload..."
docker exec proxy-server nginx -s reload

echo "✓ $DOMAIN için vhost proxy-server'da devreye alındı."
