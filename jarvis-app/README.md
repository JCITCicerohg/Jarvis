# Jarvis

Implementation of the `Jarvis v2` Claude Design handoff: Vite + React + TypeScript front end, with a small Express proxy that talks to Claude.

## Run

```sh
npm install
npm run dev            # web on :5173, API on :8787 (Vite proxies /api)
```

Open http://localhost:5173. On first run Jarvis shows a setup screen: paste your Anthropic API key and it's checked with Anthropic, then saved DPAPI-encrypted to `data/anthropic-key.bin`. Change it later under Apps → Claude API key. The setup endpoint only accepts requests from this PC. `ANTHROPIC_API_KEY` in `.env` still works as a fallback; a key saved in the app takes priority.

URL params: `?demo=1` (the prototype's simulated tasks instead of the live agent), `?preview=mobile` (390px phone frame), `?hud=0` (no HUD rings), `?voice=1` (spoken replies on).

## Live agent

By default Jarvis runs real tasks on this PC with the "autonomous executive assistant" prompt (`server/agent/prompt.ts`). It follows an Observe → Reason → Act → Report loop (`server/agent/runner.ts`) and streams each step to the UI over SSE (`GET /api/events`).

| Engine | Tools | Status |
| --- | --- | --- |
| Hybrid_Memory_Engine | `memory_query`, `memory_write`, `memory_save_rule` | SQLite + FTS5 at `data/memory.db` |
| OS_Controller & CLI | `shell_exec`, `fs_list`, `fs_read`, `fs_write` | PowerShell, full access |
| Admin escalation | `request_admin`, then `shell_exec elevated=true` | One approval + one UAC prompt per server session |
| Browser_Engine | `browser_open/snapshot/click/type/select/extract/screenshot/navigate` | Your installed Edge via Playwright, profile in `data/browser-profile` |
| Microsoft_Graph_API | `mail_*`, `calendar_*`, `files_search`, `file_list/download/upload/delete`, `teams_list/send`, `graph_get` | Device-code sign-in; tokens DPAPI-encrypted at `data/msal-cache.bin` |
| Analytics_Engine | `analytics_profile`, `analytics_query` | DuckDB SQL over CSV / JSON / Parquet / Excel |
| Self_Modification_Engine | `self_propose_patch`, `self_list_patches`, `self_revert_patch` | Edits its own `src/` and `server/`; typechecked on a staged copy, shown as a diff, applied only after you approve. Backups in `data/self-mod/<id>/` |

**What still asks you, even with admin granted** (`server/agent/tools/risk.ts`):
- recursive deletes, disk/partition operations, registry deletes, `git push --force` / `reset --hard` / `clean -f`
- overwriting an existing file, and SQL that writes files (`COPY … TO`)
- sending mail, invites with attendees, Teams posts, and deleting or replacing OneDrive/SharePoint files
- browser clicks labelled send/post/share, pay/checkout/place order, or delete/remove

The model can also call `request_approval` for anything else irreversible.

**Self-modification (production + workspace):** the running app is production, and Jarvis never edits it directly. It works on a full copy in `.workspace/`: it edits files there (each edit is typechecked, and undone if it breaks the build), then `self_test` runs the unit tests and starts the workspace as a separate test instance (web http://localhost:5174, API :8788, its own data in `data/test-instance/`) that it can drive with its browser tools, while the live app keeps running. When the change works, `self_release` shows you the full diff. After you approve, the update waits until you're idle (no task running, no clicks, keys or chat for 3 minutes), so Jarvis never restarts in the middle of your session. Press **Apps → Self-modification → Apply now** to apply it sooner. Front-end changes hot-reload; server changes restart the API. Ask Jarvis to "revert update <id>" to undo one (`data/self-mod/<id>/` has the backup and diff). It can't edit the approval gates, the engine, the supervisor or the repair limits, and you can turn it off in Apps.

**Self-repair:** `npm run dev` / `npm start` run the API under `server/supervisor.ts`, which restarts it after a crash (with backoff) or when a file under `server/` changes, and mirrors its output to `data/server.log`. After an update touches `server/` it waits for `/api/health`; if the API doesn't come up, it rolls the update back. Errors in Jarvis's own code (a failed task or chat request, an uncaught error or compile error in the browser, a crash, a rollback) start a "Self-repair" task that diagnoses the cause, fixes and tests it in the workspace, and asks you to approve the update. Network, rate-limit and API-key errors don't. At most one repair per distinct error per 30 minutes and four per hour.

**Browser:** Jarvis drives its own Edge window. Sign in to M3, BevSpot and Toast there once and the profile keeps you signed in. If an element moves after a page re-render, Jarvis re-finds it by label and logs "Jarvis fixed itself". Downloads land in `data/downloads/`, where the Analytics engine can query them.

**Apps modal:** it shows real connection state. Connect/Disconnect Microsoft 365 there, and turn browser automation or analytics off; the tools then refuse to run.

### Microsoft 365 setup
1. Azure portal → Microsoft Entra ID → App registrations → New registration (single tenant is fine).
2. Authentication → Advanced settings → **Allow public client flows: Yes** (needed for device-code sign-in).
3. API permissions → Microsoft Graph → Delegated: `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite.All Sites.Read.All Chat.ReadWrite ChannelMessage.Send Team.ReadBasic.All Channel.ReadBasic.All`. Grant admin consent if your tenant requires it.
4. Put the Application (client) ID in `MS_CLIENT_ID` and the Directory (tenant) ID in `MS_TENANT_ID` in `.env`, then restart.
5. In Jarvis, go to Apps → Outlook → Connect, open the link shown, and enter the code.

- **Admin controls:** "Admin on" in the header ends the admin session. "Stop all" aborts every running task.
- **Audit log:** every command and file write is appended to `data/audit.jsonl`.
- **Tests:** `npx vitest run` covers the risk classifier.

## Layout

- `src/styles/nocturne.css` – the Nocturne design-system tokens and classes, copied from the handoff.
- `src/components/JarvisFace.tsx` – the three.js blob and the canvas HUD.
- `src/useJarvis.ts` – app state: the task simulation tick, approvals, voice in and out, and chat.
- `src/components/{Home,Transcript,Modal}.tsx` – desktop and mobile home, the transcript sheet, and the Task/Tasks/Approvals/Memory/Apps modals.
- `server/index.ts` – routes: `/api/chat`, `/api/events` (SSE), `/api/tasks/:id/{decide,pause}`, `/api/stop`, `/api/admin/revoke`, `/api/memory`.
- `server/chat.ts` – the conversational loop on `claude-opus-5-5` at low effort. Its tools are `start_task`, `decide`, `memory_query` and `memory_save_rule`.
- `server/agent/` – the prompt, the task runner (`claude-opus-5-5`, high effort, streaming), and `tools/`: memory, OS, browser, graph, analytics, the risk classifiers, and the elevated worker `admin-worker.ps1`.
- `server/integrations.ts` – Apps modal state, the Microsoft sign-in flow, and engine on/off switches.
- `server/state.ts` – server-owned tasks and decisions, persisted to `data/tasks.json`.

With `?demo=1`, tasks and integrations are the prototype's seeded demo data and nothing real is browsed, sent or paid. The live mode (the default) acts on this PC and your accounts, with the approval gates above.
