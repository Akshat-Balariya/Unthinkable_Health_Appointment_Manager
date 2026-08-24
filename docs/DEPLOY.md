# Deployment & External Services

## Google Calendar

Calendar sync stays **disabled** until configured, and an unconnected user is a
silent no-op — the app runs fully without it.

1. <https://console.cloud.google.com> → create a project
2. **APIs & Services → Library** → enable **Google Calendar API**
3. **OAuth consent screen** → External → add your account under **Test users**
   (an unverified app only works for listed testers)
4. **Credentials → Create OAuth client ID → _Web application_**
   Authorised redirect URI — exactly, no trailing slash:
   ```
   http://localhost:4000/api/calendar/google/callback
   ```
   For production, add your deployed API origin as a second URI.
5. In `server/.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_CALENDAR_ENABLED=true
   ```

Then sign in, open **Settings → Connect Google Calendar**, and approve. Google
shows an "unverified app" warning for test-user OAuth — *Advanced → Go to (unsafe)*.

**Troubleshooting**

| Error | Cause |
|---|---|
| `redirect_uri_mismatch` | URI not registered, or differs by a slash/port/scheme |
| `access_denied` / "not completed verification" | Your account is not a **Test user** |
| `invalid_client` | Wrong client id/secret |
| Rejects the redirect outright | Client created as *Desktop app* — must be **Web application** |

Refresh tokens are encrypted at rest with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`).
Sync is reconciling: `calendar_events` records what Google holds, the appointment
records what it should hold, and the worker converges them — so cancel and
reschedule need no calendar-specific hooks, and a missed pass self-heals.

## Email

`MAIL_TRANSPORT=console` (default) logs messages instead of sending — nothing
escapes a development machine seeded with fake addresses. For real delivery:

```
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp-relay.brevo.com     # or SendGrid, Mailgun, Mailtrap
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM_EMAIL=no-reply@yourdomain
```

Free options: **Brevo** (300/day), **Mailtrap** (captures mail without delivering,
ideal for a demo), **SendGrid**.

## LLM

Get a free key and set two variables:

| Provider | Key from | Variables |
|---|---|---|
| Gemini | <https://aistudio.google.com/apikey> | `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` |
| Groq | <https://console.groq.com/keys> | `LLM_PROVIDER=groq`, `GROQ_API_KEY` |
| OpenRouter | <https://openrouter.ai/keys> | `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY` |

Leave `LLM_PROVIDER=mock` to run without any key. Pin a specific model rather than
an alias like `gemini-flash-latest` — aliases can be retired or heavily queued
(one was measured at 129 s against 3.5 s for the pinned model).

## Hosting

The backend is a plain Express app and the frontend a static Vite build, so most
free tiers work. Database: **Neon** or **Supabase** (free Postgres).

### Render / Railway

**API service**

| Setting | Value |
|---|---|
| Root directory | `server` |
| Build | `npm install && npx prisma generate && npx prisma migrate deploy` |
| Start | `npm start` |

**Static site**

| Setting | Value |
|---|---|
| Root directory | `client` |
| Build | `npm install && npm run build` |
| Publish directory | `dist` |

Add a rewrite of `/*` → `/index.html` so client-side routes resolve on refresh.

### Required environment variables

Everything in `server/.env.example`, with these changed for production:

```
NODE_ENV=production
API_BASE_URL=https://your-api.onrender.com
CLIENT_BASE_URL=https://your-app.onrender.com
DATABASE_URL=<managed Postgres URL>
JWT_ACCESS_SECRET=<new random 48+ bytes>
JWT_REFRESH_SECRET=<new random 48+ bytes>
TOKEN_ENCRYPTION_KEY=<new random 32 bytes as 64 hex chars>
GOOGLE_REDIRECT_URI=https://your-api.onrender.com/api/calendar/google/callback
MAIL_TRANSPORT=smtp
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`CLIENT_BASE_URL` is the CORS allow-list origin — a mismatch shows as browser CORS
errors. The Google redirect URI must also be added in Cloud Console.

### Notes for free tiers

- **Instances sleep.** Background workers stop with them; queued email and
  summaries send late rather than being lost, because both are durable database
  rows. An external cron pinging `/health` every 10 minutes keeps a dyno awake.
- **No Redis needed.** Jobs use a database-backed outbox by design.
- Set `WORKER_ENABLED=true` on a single-service deploy so jobs run in-process. On
  multi-instance deploys, run `npm run worker` separately and leave it `true` —
  every job claims work with a conditional `UPDATE` (`FOR UPDATE SKIP LOCKED` for
  the outbox), so duplicate workers divide the queue rather than duplicating it.
- Migrations run at build time via `prisma migrate deploy`. Seed once by hand:
  `npm run db:seed`.

### Post-deploy check

```bash
curl https://your-api.onrender.com/health/ready
```

```json
{ "status": "ready",
  "checks": { "database": "ok", "llmProvider": "gemini",
              "mailTransport": "smtp", "googleCalendar": "enabled" } }
```
