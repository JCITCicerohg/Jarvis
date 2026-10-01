#!/usr/bin/env bash
# Imports (or re-imports, same id) the KB sync workflow and activates it.
set -euo pipefail
cd /opt/jarvis-kb
dc="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
for i in $(seq 1 30); do $dc exec -T n8n n8n --version >/dev/null 2>&1 && break; sleep 5; done
$dc exec -T n8n n8n import:workflow --input=/workflows/kb-sync.json
$dc exec -T n8n n8n update:workflow --id=kbsync5min0001 --active=true
$dc restart n8n
