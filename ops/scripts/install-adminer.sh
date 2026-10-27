#!/usr/bin/env bash
# ops/scripts/install-adminer.sh
#
# Adminer (tek dosyalık PHP DB yönetim arayüzü — hem PostgreSQL hem
# MySQL/MariaDB'yi tek arayüzden yönetir, bkz. madde 4 kararı: phpMyAdmin
# yerine Adminer). Bu sandbox'ta ÇALIŞTIRILMAZ — gerçek sunucuda, PHP CLI
# kuruluyken bir kez çalıştırılır.
#
# Kullanım: sudo ops/scripts/install-adminer.sh
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

command -v php >/dev/null 2>&1 || fail "PHP CLI bulunamadı (apk add php83 veya dağıtımınıza uygun paket)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="$PROJECT_ROOT/ops/adminer"
TARGET_FILE="$TARGET_DIR/adminer.php"

mkdir -p "$TARGET_DIR"

if [ -f "$TARGET_FILE" ]; then
  echo "» $TARGET_FILE zaten var, indirme atlanıyor."
else
  command -v curl >/dev/null 2>&1 || fail "curl yok — adminer.php'yi elle $TARGET_FILE konumuna kopyalayın (https://www.adminer.org/)."
  # Adminer'in resmi sabit bağlantısı güncel kararlı sürüme yönlenir.
  # GitHub API hız sınırına bağlı indirme kurulumları bozmasın.
  echo "» Adminer resmi siteden indiriliyor..."
  temp_file="$(mktemp "$TARGET_DIR/.adminer.XXXXXX.php")"
  trap 'rm -f "$temp_file"' EXIT
  curl -fsSL --retry 3 --connect-timeout 10 https://www.adminer.org/latest.php -o "$temp_file" \
    || fail "İndirme başarısız — internet erişimi yoksa adminer.php'yi elle $TARGET_FILE konumuna kopyalayın (https://www.adminer.org/)."
  php -l "$temp_file" >/dev/null || fail "İndirilen Adminer dosyası geçerli PHP değil."
  mv "$temp_file" "$TARGET_FILE"
  trap - EXIT
fi

echo "» Kurulum tamam. Servisi başlatmak için:"
echo "    screen -dmS studio-panel-adminer $SCRIPT_DIR/supervise.sh adminer"
echo "» Ardından .env.loopkit içine ekleyin (nginx reverse-proxy ile dışa açtığınız adres):"
echo "    ADMINER_URL=https://panel-adminer.ornek.com"
echo "» Adminer'i 127.0.0.1:8098 dışına ASLA doğrudan açmayın — önüne nginx reverse-proxy + kendi kimlik doğrulamanızı (basic auth veya panel SSO) koyun; Adminer'in kendi login ekranı DB kimlik bilgisi ister, ekstra bir erişim katmanı olmadan internete açık bırakmak risklidir."
