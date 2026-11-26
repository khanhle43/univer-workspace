# Deploy the Realtime WebSocket Server

Univer Workspace splits realtime across two hosts:

- **Vercel (serverless)** — serves the static frontend and the HTTP API. It **cannot** hold
  long-lived WebSocket connections, so it mints session tickets over HTTP and stores them in
  Postgres.
- **Realtime server (Docker / VM / Railway / Render)** — a long-lived process running the full
  Express + WebSocket app. It consumes the tickets from the shared Postgres store and serves the
  collaboration and worktree WebSocket upgrades.

```
Browser ──HTTP──> Vercel (frontend + API) ──mints ticket──> Postgres (session_tickets)
Browser ──WS────> Realtime server ──consumes ticket──> Postgres (session_tickets)
```

The frontend connects its WebSockets to the realtime server via `VITE_WS_HOST` (a build-time
Vite variable). When it is unset, the browser falls back to the page origin (same-host
deployments where one origin serves both HTTP and WS).

## Prerequisites

- A Univer Workspace deployment on Vercel (HTTP) backed by Supabase Postgres + S3, already running.
- The Postgres connection string and S3 credentials used by the Vercel deployment.
- Docker (or a VM / Railway / Render service) to run the long-lived realtime server.
- `pnpm` available on the machine that builds the image (the Dockerfile uses `corepack`).

## 1. Deploy the realtime server

The repo ships a `docker-compose.yml` at the repository root that builds the realtime image from
`apps/workspace/Dockerfile` and runs `dist/server/main.js` (the full Express + WebSocket server).

Create a `.env` file next to `docker-compose.yml` (or export the variables) with the same Supabase
Postgres + S3 settings the Vercel deployment uses:

```dotenv
# Supabase Postgres (use the IPv4 Session Pooler: aws-1-<region>.pooler.supabase.com:5432)
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true

# S3 / Supabase Storage
BLOB_STORE=s3
BLOB_S3_BUCKET=univer-bucket
BLOB_S3_REGION=ap-southeast-1
AWS_ACCESS_KEY_ID=<anon-key>
AWS_SECRET_ACCESS_KEY=<service-role-key>
BLOB_S3_FORCE_PATH_STYLE=true

# Public origin of this realtime server (used for OAuth issuer and absolute URLs)
PUBLIC_ORIGIN=https://ws.example.com
```

Then build and start it:

```bash
docker compose up -d --build
```

The server listens on port `3020` (mapped from the container). Verify it is up:

```bash
curl http://localhost:3020/healthz
# or, from outside the container:
curl https://ws.example.com/healthz
```

### Schema migration

On first start the server runs `initializePostgresSchema`, which creates the `session_tickets`
table (and applies any pending product schema upgrades) in a single transaction. No manual SQL is
required. The table is shared with Vercel, which also runs the same migration on its next warm-up.

### Running on Railway / Render / a VM

Instead of Docker Compose, build the image and run it on any long-lived host:

```bash
docker build -f apps/workspace/Dockerfile -t univer-workspace-realtime .
docker run -d --name realtime -p 3020:3020 \
  -e DATABASE_URL=... -e BLOB_STORE=s3 -e BLOB_S3_BUCKET=... \
  --restart unless-stopped univer-workspace-realtime
```

The container needs the same environment variables listed in `docker-compose.yml`. Point
`PUBLIC_ORIGIN` at the host's public URL.

## 2. Configure Vercel (`VITE_WS_HOST`)

The browser must open WebSockets to the realtime server, not to the Vercel origin. Set
`VITE_WS_HOST` in the Vercel project's build environment and redeploy:

- In the Vercel dashboard: **Project → Settings → Environment Variables**, add
  `VITE_WS_HOST` with the realtime server's public URL, e.g. `wss://ws.example.com` (or a bare
  host `ws.example.com`).
- Or set it via the CLI / API and redeploy.

`VITE_WS_HOST` is a **build-time** Vite variable, so it is baked into the frontend bundle at build
time. After setting it, trigger a new Vercel deployment so the frontend rebuilds with the new value.

> If you leave `VITE_WS_HOST` unset, WebSockets connect to the current page origin. That works only
> when the realtime server is fronted by the same origin as the HTTP frontend (e.g. behind one
> reverse proxy). With a separate Vercel + realtime split, you must set it.

## 3. Verify

1. **HTTP still works** — `https://<vercel-url>/healthz` returns `{"status":"ok"}`, and the app
   loads.
2. **Ticket minting** — `GET https://<vercel-url>/universer-api/user/session-ticket` (with a
   session cookie) returns `{ "ticket": "..." }`. The row is stored in `session_tickets` in
   Postgres.
3. **WebSocket handshake** — open the WS URL the browser would use:
   ```
   wss://ws.example.com/universer-api/comb/connect?sessionTicket=<ticket>
   ```
   It should complete the upgrade (the ticket is consumed via `DELETE … RETURNING`). A second
   connect with the same ticket fails with an authentication error — that is the one-time
   consume working.
4. **Realtime push** — open two browser tabs editing the same unit; changes should sync in real
   time. The worktree change feed (`/api/worktree-events`) should also push without the
   `WebSocket connection failed` / `AbortError` errors seen on serverless-only deployments.

## Troubleshooting

- **`WebSocket connection to 'wss://…' failed`** — the browser is still connecting to the wrong
  host. `VITE_WS_HOST` was not set, or the Vercel deployment did not rebuild after setting it.
- **`401` / ticket rejected on the WS upgrade** — the ticket was already consumed or expired
  (TTL is 5 minutes by default). Mint a fresh ticket. Confirm both Vercel and the realtime server
  point at the same Postgres `session_tickets` table.
- **Realtime server won't start** — check `DATABASE_URL` reachability (use the IPv4 Supavisor
  Session Pooler, not the IPv6-only direct host) and that `BLOB_STORE=s3` + S3 credentials are
  valid.
- **`Identifier "..." already exists` in the server log** — normal DI logging, ignorable.

## Files

- `docker-compose.yml` — realtime server service definition.
- `apps/workspace/Dockerfile` — builds the full app and runs `dist/server/main.js`.
- `apps/workspace/server/src/main.ts` — long-lived entrypoint: `createServer` + `attachWebSocket`,
  creates the Postgres ticket store, starts the sweeper, disposes on shutdown.
- `apps/workspace/server/src/integrations/realtime/postgres-session-ticket-store.ts` — the shared
  Postgres `ISessionTicketStore`.
- `apps/workspace/server/src/db/postgres/schema.sql` + `initialize.ts` — `session_tickets` table
  and migration.
- `api/index.js` — Vercel HTTP entrypoint; also creates the Postgres ticket store so it shares
  the table with the realtime server.
- `apps/workspace/web/src/shared/ws-host.ts` — resolves the WebSocket host from `VITE_WS_HOST`.
