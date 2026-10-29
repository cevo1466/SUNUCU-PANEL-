#!/usr/bin/env bash
# Update an installed panel without replacing its database, domains or secrets.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
err() { printf 'HATA: %s\n' "$*" >&2; exit 1; }
say() { printf '\n» %s\n' "$*"; }

[[ $EUID -eq 0 ]] || err "Güncelleme root ile çalışmalı: sudo bash update.sh"
[[ -f .env && -d data/vhosts/studio-panel ]] || err "Kurulu panel bulunamadı."
container_name=$(sed -n 's/^PANEL_CONTAINER_NAME=//p' .env | head -1)
[[ "$container_name" =~ ^[a-z][a-z0-9_-]{1,49}$ ]] || err "Konteyner adı kurulum ayarlarında geçersiz."
image="$container_name:local"
previous_image=$(docker image inspect "$image" --format '{{.Id}}') \
  || err "Mevcut panel imajı bulunamadı: $image"
docker compose --env-file .env config -q

say "Yeni panel imajı oluşturuluyor; mevcut panel bu sırada çalışmaya devam eder"
docker compose --env-file .env build

backup_dir="$ROOT/data/upgrade-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$backup_dir"
chmod 0700 "$ROOT/data/upgrade-backups" "$backup_dir"
rollback_needed=0
rollback() {
  local status=$?
  trap - EXIT
  if (( rollback_needed )); then
    printf 'Güncelleme tamamlanamadı; önceki kaynaklar ve imaj geri yükleniyor.\n' >&2
    docker compose --env-file .env stop panel >/dev/null 2>&1 || true
    if [[ -d "$backup_dir/overwritten" ]]; then
      docker run --rm --entrypoint /bin/sh \
        -v "$ROOT/data/vhosts:/var/www/vhosts" -v "$backup_dir:/upgrade-backup" \
        "$image" -ec 'rsync -a --chown=1001:1001 /upgrade-backup/overwritten/ /var/www/vhosts/studio-panel/' \
        || printf 'Kaynakları otomatik geri yükleme başarısız: %s\n' "$backup_dir" >&2
    fi
    docker tag "$previous_image" "$image" || true
    docker compose --env-file .env up -d --no-build --force-recreate || true
  fi
  exit "$status"
}
trap rollback EXIT

say "Panel kısa süre durduruluyor; veri dizinleri korunarak kaynak kodu güncelleniyor"
rollback_needed=1
docker compose --env-file .env stop panel
docker run --rm --entrypoint /bin/sh \
  -v "$ROOT/data/vhosts:/var/www/vhosts" -v "$backup_dir:/upgrade-backup" \
  "$image" -ec '
    rsync -a --chown=1001:1001 --backup --backup-dir=/upgrade-backup/overwritten \
      --exclude=/.env.loopkit \
      --exclude=/packages/db/.pgdata/ \
      --exclude=/ops/generated/ \
      --exclude=/ops/backups/ \
      --exclude=/ops/run/ \
      --exclude="*.log" \
      /opt/panel-template/ /var/www/vhosts/studio-panel/
  '
docker compose --env-file .env up -d --no-build --force-recreate

ready=0
for _ in {1..120}; do
  if docker exec "$container_name" curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 \
    && docker exec "$container_name" curl -fsS http://127.0.0.1:3000/login -o /dev/null >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
(( ready )) || err "Panel sağlık kontrolü başarısız; otomatik geri yükleme başlatılıyor."

rollback_needed=0
trap - EXIT
say "Panel güncellendi. Önceki kaynak dosyalarının kopyaları: $backup_dir"
