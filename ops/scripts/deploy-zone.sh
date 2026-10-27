#!/usr/bin/env bash
# ops/scripts/deploy-zone.sh <domain>
#
# PROD-ONLY. Sunucunun kendi (Cloudflare dışı) otoriter DNS'i için — bkz.
# madde 5 kararı, apps/api/src/lib/localDns.ts. ops/generated/zones/<domain>.zone
# dosyasını /etc/bind/zones/'a kopyalar, named-checkzone ile doğrular, SADECE
# başarılıysa BIND'e reload sinyali gönderir (rndc reload <domain>).
#
# deploy-vhost.sh ile AYNI güvenlik deseni: apps/api bu script'i SADECE
# sudoers'ta bu tek script'e tanımlanmış dar kapsamlı, şifresiz bir kuralla
# çağırır (bkz. PROD-DEPLOYMENT.md). Script kendi içinde domain adını
# doğrular ve doğrulama başarısız olursa reload YAPMAZ.
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "Kullanım: $0 <domain>"
DOMAIN="$1"

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || fail "Geçersiz domain adı: $DOMAIN"

[ "$(id -u)" = "0" ] || fail "Bu script root gerektirir (rndc reload için). 'sudo $0 $DOMAIN' ile çalıştırın."
command -v named-checkzone >/dev/null 2>&1 || fail "named-checkzone bulunamadı (bind-tools kurulu değil)."
command -v rndc >/dev/null 2>&1 || fail "rndc bulunamadı (BIND kurulu değil)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_ZONE="$PROJECT_ROOT/ops/generated/zones/${DOMAIN}.zone"
ZONES_DIR="/etc/bind/zones"
DEST_ZONE="$ZONES_DIR/${DOMAIN}.zone"

[ -f "$SRC_ZONE" ] || fail "Üretilmiş zone bulunamadı: $SRC_ZONE (önce POST /api/domains/:id/dns/local-apply çağrılmalı)"

echo "» $SRC_ZONE doğrulanıyor..."
named-checkzone "$DOMAIN" "$SRC_ZONE" || fail "named-checkzone başarısız — zone uygulanmadı."

mkdir -p "$ZONES_DIR"
if [ -f "$DEST_ZONE" ]; then
  cp "$DEST_ZONE" "${DEST_ZONE}.bak.$(date +%s)"
fi
cp "$SRC_ZONE" "$DEST_ZONE"
chown root:named "$DEST_ZONE"
chmod 0640 "$DEST_ZONE"

# named.conf.local'da bu domain için zone bloğu yoksa ekle. Zaten varsa
# dokunmuyoruz — operatörün elle yaptığı özelleştirmeleri (allow-transfer vb.)
# ezmeyiz.
NAMED_CONF_LOCAL="/etc/bind/named.conf.local"
IS_NEW_ZONE=0
if [ -f "$NAMED_CONF_LOCAL" ] && ! grep -q "zone \"${DOMAIN}\"" "$NAMED_CONF_LOCAL"; then
  IS_NEW_ZONE=1
  {
    echo ""
    echo "zone \"${DOMAIN}\" {"
    echo "    type master;"
    echo "    file \"${DEST_ZONE}\";"
    echo "};"
  } >> "$NAMED_CONF_LOCAL"
  echo "» named.conf.local'a ${DOMAIN} zone bloğu eklendi."
fi

echo "» BIND yapılandırması test ediliyor (named-checkconf)..."
if command -v named-checkconf >/dev/null 2>&1 && ! named-checkconf; then
  fail "named-checkconf başarısız — named.conf.local'ı elle kontrol edin, reload YAPILMADI."
fi

# YENİ bir zone bloğu için "rndc reload <domain>" başarısız olur (zone henüz
# named'in çalışan yapılandırmasında yok, "not found" hatası verir) — named.conf'u
# yeniden okuyup yeni zone'u tanıması için "rndc reconfig" gerekir. Var olan bir
# zone'un İÇERİĞİ değiştiğinde ise (blok zaten oradaysa) hedefe özel "reload"
# yeterli ve daha ucuzdur (tüm named.conf'u yeniden taramaz).
if [ "$IS_NEW_ZONE" = "1" ]; then
  echo "» rndc reconfig (yeni zone)..."
  rndc reconfig
else
  echo "» rndc reload ${DOMAIN}..."
  rndc reload "$DOMAIN"
fi
echo "✓ ${DOMAIN} zone'u uygulandı ve BIND'e yeniden yüklendi."
