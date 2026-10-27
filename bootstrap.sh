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
[[ ! -e "$target" ]] || { echo "$target zaten var; mevcut kurulum korunuyor." >&2; exit 1; }
git clone --depth 1 --branch main https://github.com/cevo1466/SUNUCU-PANEL-.git "$target"
exec bash "$target/install.sh"
