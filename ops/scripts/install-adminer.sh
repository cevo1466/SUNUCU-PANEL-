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
  # v6'dan beri sabit "adminer.php" varlığı yok — sürümlü dosya adları var
  # (adminer-6.0.1.php gibi); GitHub API'den gerçek indirme URL'i çözülür.
  echo "» En güncel Adminer sürümü GitHub API'den bulunuyor..."
  URL="$(curl -fsSL https://api.github.com/repos/vrana/adminer/releases/latest \
    | grep -o '"browser_download_url": *"[^"]*/adminer-[0-9][^"/]*\.php"' \
    | grep -v -- '-en\.php"\|-mysql' \
    | head -1 \
    | sed -E 's/.*"(https:[^"]+)"/\1/')"
  [ -n "$URL" ] || fail "GitHub release'de uygun adminer-*.php bulunamadı — elle $TARGET_FILE konumuna kopyalayın (https://www.adminer.org/)."
  echo "» $URL indiriliyor..."
  curl -fsSL "$URL" -o "$TARGET_FILE" || fail "İndirme başarısız — internet erişimi yoksa adminer.php'yi elle $TARGET_FILE konumuna kopyalayın (https://www.adminer.org/)."
fi

echo "» Kurulum tamam. Servisi başlatmak için:"
echo "    screen -dmS studio-panel-adminer $SCRIPT_DIR/supervise.sh adminer"
echo "» Ardından .env.loopkit içine ekleyin (nginx reverse-proxy ile dışa açtığınız adres):"
echo "    ADMINER_URL=https://panel-adminer.ornek.com"
echo "» Adminer'i 127.0.0.1:8098 dışına ASLA doğrudan açmayın — önüne nginx reverse-proxy + kendi kimlik doğrulamanızı (basic auth veya panel SSO) koyun; Adminer'in kendi login ekranı DB kimlik bilgisi ister, ekstra bir erişim katmanı olmadan internete açık bırakmak risklidir."
