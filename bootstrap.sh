#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo 'root olarak çalıştır: sudo bash bootstrap.sh' >&2; exit 1; }
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates git
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates git
  else
    echo 'HATA: git için apt-get veya dnf gerekli.' >&2
    exit 1
  fi
fi
target=/opt/studio-panel-installer
if [[ -d "$target/.git" ]]; then
  [[ ! -f "$target/.env" ]] || { echo "$target içinde kurulum ayarları var; mevcut kurulum korunuyor." >&2; exit 1; }
  [[ "$(git -C "$target" remote get-url origin)" == https://github.com/cevo1466/SUNUCU-PANEL-.git ]] \
    || { echo "$target farklı bir depoya bağlı; otomatik güncelleme durduruldu." >&2; exit 1; }
  git -C "$target" pull --ff-only origin main
  exec bash "$target/install.sh"
fi
[[ ! -e "$target" ]] || { echo "$target zaten var ama Git deposu değil; mevcut dosyalar korunuyor." >&2; exit 1; }
git clone --depth 1 --branch main https://github.com/cevo1466/SUNUCU-PANEL-.git "$target"
exec bash "$target/install.sh"
