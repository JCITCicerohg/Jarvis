# kb-service

Jarvis's company knowledge base: mirrors SharePoint folders (see `config/sources.yaml`) into Postgres + pgvector, and answers questions through `/v1/query` (planner → boolean plan → executor → Result JSON).

## Run locally

    docker compose up -d db
    cp .env.example .env    # fill in keys, see "Microsoft 365 access"
    npm install
    npm test                # needs the db container
    npm run smoke           # one full sync of Hilton PBI + three sample questions
    npm run dev             # API on :8790, syncs every SYNC_MINUTES

## API (Authorization: Bearer <key from KB_API_KEYS>)

- `POST /v1/query {question}` → Result JSON (answer_data, passages or files, sources, coverage.missing, notes, confidence, generation)
- `POST /v1/search {query, filter?, k?}` → passages
- `GET /v1/datasets?dataset=&hotel=&from=&to=` and `GET /v1/datasets/:id/file` (Parquet)
- `GET /v1/status`, `POST /v1/sync {source?}`, `GET /health`

## Eval

    npm run eval            # hit@5 and MRR over eval/questions.jsonl; exits 1 below 0.85

Add real questions to `eval/questions.jsonl` (`expected_files`, optional `expected_value`).

## Deploy to DigitalOcean

**Status: plan — not deployed yet.** Nothing below has been run; review it, then run the steps in order.

### Where it runs

| | Option A — new droplet `jarvis-kb` (recommended) | Option B — existing `Cicerojarv` (159.223.113.250) |
|---|---|---|
| Size / cost | `s-2vcpu-4gb`, nyc3, $24/mo | no extra cost |
| Isolation | KB, its Postgres and its own n8n are separate from the live automations | shares 2 vCPU / ~2 GB free RAM with n8n, browserless, steel; local embeddings + Postgres need ~1.5 GB |
| Tooling | `npm run do:provision` + `npm run do:deploy` already exist and are tested | needs new compose wiring into `/opt/jarvis` (Caddy route, networks, memory caps) — not built yet |
| Risk | none to production | a KB rebuild (CPU-heavy embedding) can slow the BevSpot/M3/Ottimate workflows |

Option A is what the scripts implement. Option B would be a separate task (merge `deploy/docker-compose.yml` services into `/opt/jarvis/docker-compose.yml`, add `kb.` route to its Caddyfile, reuse its n8n).

### What gets deployed (Option A)

One droplet running Docker Compose from `deploy/docker-compose.yml`:

- `db` — Postgres 16 + pgvector (data volume, never exposed publicly)
- `kb` — this service (API :8790, syncs every `SYNC_MINUTES`)
- `n8n` — runs the `kb-sync` workflow (`deploy/n8n/kb-sync.json`) that calls `POST /v1/sync` every 5 minutes
- `caddy` — HTTPS for `kb.<ip-dashed>.sslip.io` and `n8n.<ip-dashed>.sslip.io` (automatic certificates, no domain needed)
- `kb-test` (optional, profile `test`, when `KB_TEST_ENABLED=1`) — the test environment on `test.kb.<host>`, database `kb_test`, sources `config/sources.test.yaml`

### Steps

1. **Prerequisites (local).** `kb-service/.env` filled in (see "Microsoft 365 access" below); clean `main` committed — the deploy ships `git archive HEAD`, not your working tree.
2. **DigitalOcean token.** A Read + Write API token in the shell environment as `DIGITALOCEAN_TOKEN`, only for the provisioning command. The account already has one stored on Cicerojarv in `/opt/jarvis/secrets/jarvis.env`; the owner either copies it into `.env_api/apikeys.txt` as `DIGITALOCEAN_TOKEN=…` or creates a new token at cloud.digitalocean.com → API. Never commit or print it.
3. **Provision** (idempotent — finds the droplet by tag `jarvis-kb` if it already exists):

       DIGITALOCEAN_TOKEN=… npm run do:provision

   Creates SSH key `~/.ssh/jarvis_do` (if missing), registers it, creates the droplet with `deploy/cloud-init.yaml` (Docker, firewall 22/80/443, `/opt/jarvis-kb`), waits for its IP, writes `deploy/.droplet.json`. Prints `https://kb.<host>`.
4. **Deploy** (re-run for every release):

       npm run do:deploy

   Generates `deploy/.secrets.json` on first run (Postgres password, n8n key, `kb_query` role password — kept locally, mode 600), builds `kb.env` from `kb-service/.env` + those secrets, ships the release over SSH, waits for first-boot setup, runs `docker compose up -d --build`, creates the `kb_test` database, starts `kb-test` if enabled, imports and activates the n8n sync workflow.
5. **Verify.**
   - `curl https://kb.<host>/health` → `{"ok":true}`
   - `curl -H "Authorization: Bearer <owner key>" https://kb.<host>/v1/status` → sources and counts
   - n8n at `https://n8n.<host>` shows `kb-sync` active
6. **Connect Jarvis.** In `jarvis-app/.env`: `KB_API_URL=https://kb.<host>` and keep `KB_API_KEY=<owner key>` (plus `KB_ADMIN_KEY` for generation/approval tools).
7. **First sync.** Only works after the Microsoft 365 grant (step 4 of the section below). Then `POST /v1/sync` or wait 5 minutes; check `/v1/status`.

### Operations

- **Logs:** `ssh -i ~/.ssh/jarvis_do root@<ip> 'cd /opt/jarvis-kb && docker compose -f deploy/docker-compose.yml logs -f kb'`
- **Backups:** `deploy/backup.sh` (gzipped `pg_dump` of the `kb` database into `/opt/jarvis-kb/backups`) on the droplet; DO droplet backups can be enabled for +20%.
- **Release / rollback of code:** check out the wanted commit, `npm run do:deploy`. Knowledge rollback is separate: `POST /v1/admin/rollback` (previous generation, kept 7 days).
- **Tear down:** destroy the `jarvis-kb` droplet in the DO console; delete `deploy/.droplet.json` and `deploy/.secrets.json` locally.

## Microsoft 365 access

1. Azure portal → Microsoft Entra ID → App registrations → New registration, name `jarvis-kb-sync`, single tenant.
2. Certificates & secrets → New client secret → put it in `KB_MS_CLIENT_SECRET`; put the Application (client) ID in `KB_MS_CLIENT_ID` and the Directory (tenant) ID in `KB_MS_TENANT_ID`.
3. API permissions → Add → Microsoft Graph → Application permissions → `Sites.Selected` → Grant admin consent.
4. In Graph Explorer, signed in as a SharePoint admin with `Sites.FullControl.All` consented:
   `GET https://graph.microsoft.com/v1.0/sites/cicerohg.sharepoint.com:/sites/CiceroHospitalityGroup` → copy `id`, then
   `POST https://graph.microsoft.com/v1.0/sites/{id}/permissions` with
   `{ "roles": ["read"], "grantedToIdentities": [{ "application": { "id": "<KB_MS_CLIENT_ID>", "displayName": "jarvis-kb-sync" } }] }`
5. Choose models (`KB_LLM_PROVIDER`; `KB_EMBED_PROVIDER=local` is free and keyless, the first run downloads the ~130 MB model) and fill the matching keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the `AZURE_OPENAI_*` values) plus `KB_API_KEYS=owner:<long random string>` here, and put the same key in `jarvis-app/.env` as `KB_API_KEY` with `KB_API_URL=http://localhost:8790`.
