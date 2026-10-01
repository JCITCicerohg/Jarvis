#!/usr/bin/env bash
# Nightly: database dump + blob archive, keep 7 days.
set -euo pipefail
cd /opt/jarvis-kb
mkdir -p backups
stamp=$(date +%F)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db pg_dump -U kb kb | gzip > "backups/kb-$stamp.sql.gz"
docker run --rm -v jarvis-kb_kbdata:/data:ro -v /opt/jarvis-kb/backups:/out busybox tar czf "/out/blobs-$stamp.tgz" -C /data blobs
find backups -type f -mtime +7 -delete
