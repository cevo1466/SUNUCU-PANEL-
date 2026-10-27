#!/bin/sh
# Cron entry point. Manual backup-run.sh and backup-verify.sh remain available
# regardless of the panel's automatic-backup setting.
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
ENABLED="$PROJECT_ROOT/ops/generated/automatic-backups.enabled"
[ -f "$ENABLED" ] || exit 0

case "${1:-}" in
  run) exec "$PROJECT_ROOT/ops/scripts/backup-run.sh" ;;
  verify) exec "$PROJECT_ROOT/ops/scripts/backup-verify.sh" ;;
  *) echo "Usage: $0 {run|verify}" >&2; exit 2 ;;
esac
