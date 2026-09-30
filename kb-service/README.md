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

## Microsoft 365 access

1. Azure portal → Microsoft Entra ID → App registrations → New registration, name `jarvis-kb-sync`, single tenant.
2. Certificates & secrets → New client secret → put it in `KB_MS_CLIENT_SECRET`; put the Application (client) ID in `KB_MS_CLIENT_ID` and the Directory (tenant) ID in `KB_MS_TENANT_ID`.
3. API permissions → Add → Microsoft Graph → Application permissions → `Sites.Selected` → Grant admin consent.
4. In Graph Explorer, signed in as a SharePoint admin with `Sites.FullControl.All` consented:
   `GET https://graph.microsoft.com/v1.0/sites/cicerohg.sharepoint.com:/sites/CiceroHospitalityGroup` → copy `id`, then
   `POST https://graph.microsoft.com/v1.0/sites/{id}/permissions` with
   `{ "roles": ["read"], "grantedToIdentities": [{ "application": { "id": "<KB_MS_CLIENT_ID>", "displayName": "jarvis-kb-sync" } }] }`
5. Choose models (`KB_LLM_PROVIDER`; `KB_EMBED_PROVIDER=local` is free and keyless, the first run downloads the ~130 MB model) and fill the matching keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the `AZURE_OPENAI_*` values) plus `KB_API_KEYS=owner:<long random string>` here, and put the same key in `jarvis-app/.env` as `KB_API_KEY` with `KB_API_URL=http://localhost:8790`.
