# Healthcare Appointment & Follow-up Manager

Appointment platform for clinics, with separate portals for **patients, doctors,
clinic admins and platform admins**. Patients book with a symptom form, doctors
get an AI triage summary before the visit, patients get a plain-language summary
after it, and both sides are kept informed by email and Google Calendar.

## Contents

| Document | Covers |
|---|---|
| [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) | **Design write-up** — double-booking, slot holds, leave cascade, notification reliability |
| [docs/API.md](docs/API.md) | Full endpoint reference |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Database schema and indexes |
| [docs/LLM.md](docs/LLM.md) | Prompts, provider adapter, failure handling |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Hosting and Google Calendar setup |

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Node 20+ / Express | Matches Nodemailer + free-tier hosting |
| Database | PostgreSQL + Prisma | Declarative schema; real migrations |
| Auth | JWT access + rotating refresh, RBAC | Four distinct portals |
| LLM | Gemini / Groq / OpenRouter / mock | Free tiers; one env var to swap |
| Email | Nodemailer (console transport in dev) | Any SMTP provider |
| Jobs | DB-backed outbox + polling workers | No Redis — free tiers have none |
| Calendar | Google Calendar API, OAuth 2.0 | Required by the brief |
| Frontend | React + Vite | ~200 kB, no UI framework |

---

## Quick start

Requires Node 20+ and PostgreSQL 14+.

```bash
cd server && npm install && cp .env.example .env
```

Create the database and edit `DATABASE_URL` in `server/.env`:

```bash
createdb -U postgres hcam
```

Then migrate, seed and start the API:

```bash
cd server && npx prisma migrate deploy && npm run db:seed && npm run dev
```

**The app needs two processes.** In a second terminal, start the frontend:

```bash
cd client && npm install && cp .env.example .env && npm run dev
```

| | |
|---|---|
| App (what you open) | <http://localhost:5173> |
| API | <http://localhost:4000> |

Both must be running. `localhost:5173` refusing to connect means the client
terminal is not running; the API alone does not serve the UI.

Migrations and the seed only need running once — the seed is idempotent, so
re-running it is safe.

Background jobs run in-process by default (`WORKER_ENABLED=true`). To run them
separately: `cd server && npm run worker`.

### Seeded accounts

All use the password `Password123!`.

| Role | Email |
|---|---|
| Platform admin | `admin@clinic.test` |
| Clinic admin | `clinic@sunrise.test` |
| Doctor | `dr.mehta@clinic.test` (General Medicine, 30-min slots) |
| Doctor | `dr.rao@clinic.test` (Cardiology, 45-min + 15-min buffer) |
| Doctor | `dr.fernandes@clinic.test` (Dermatology, 20-min) |
| Doctor | `dr.khan@clinic.test` (Pediatrics, 15-min) |
| Patient | `patient.one@example.test` … `patient.three@example.test` |

`npm run db:clean` removes accounts left behind by the test suites.

---

## Configuration

Full list with comments in [`server/.env.example`](server/.env.example). The ones
that matter:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | — | Token signing (16+ chars) |
| `TOKEN_ENCRYPTION_KEY` | — | AES-256-GCM key for OAuth tokens (64 hex chars) |
| `SLOT_HOLD_TTL_SECONDS` | `600` | How long a held slot is reserved |
| `APPOINTMENT_REMINDER_LEAD_MINUTES` | `1440` | Reminder lead time |
| `LLM_PROVIDER` | `gemini` | `gemini` / `groq` / `openrouter` / `mock` |
| `MAIL_TRANSPORT` | `console` | `console` logs instead of sending |
| `GOOGLE_CALENDAR_ENABLED` | `false` | Calendar stays off until configured |
| `WORKER_ENABLED` | `true` | Run background jobs in-process |

Config is validated with Zod at boot — a missing or malformed value fails fast
with a readable message rather than at the first request that needs it.

---

## How it works

**Booking is two-phase**, because the brief requires a symptom form *before*
confirmation and that form takes minutes:

```
POST /appointments/hold          → HELD row written immediately (10-min TTL)
      patient fills symptom form
POST /appointments/:id/confirm   → CONFIRMED + symptoms + emails + calendar
```

Writing the `HELD` row up front means the slot occupies the database's unique
index from the first click, so a second patient is rejected at *hold* time rather
than after filling in the whole form.

**Availability is computed, never stored.** A slot exists only if it survives four
filters: inside an active working block, not overlapping leave, not overlapping a
`HELD`/`CONFIRMED` appointment, and within the notice/advance window.

**Nothing is sent inline.** Emails and calendar changes are written to a
transactional outbox in the same transaction as the business change, then drained
by workers with backoff and a dead-letter queue.

**LLM output degrades, never blocks.** Summaries generate asynchronously into rows
with a `PENDING → READY/FAILED` lifecycle. A provider outage costs one field.

Full reasoning in [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md).

---

## Multi-tenancy

Clinics register themselves at `/register-clinic`, then add and manage their own
doctors.

| Role | Scope |
|---|---|
| `CLINIC_ADMIN` | One clinic — sees and edits only its own doctors |
| `ADMIN` | Platform-wide |
| `PATIENT` | Searches doctors across **all** clinics |

The tenancy scope comes from the verified JWT, never the request body. Cross-tenant
access returns **404, not 403**, so one clinic cannot enumerate another's staff.

---

## Verification

```bash
cd server && npm run verify:all
```

| Suite | Checks | Covers |
|---|---|---|
| `verify:slots` | 3 | Database-level concurrency guards |
| `verify:leave` | 14 | Leave conflict cascade |
| `verify:booking` | 53 | Full booking lifecycle over HTTP |
| `verify:holds` | 11 | Hold TTL, inline reaping, sweeper |
| `verify:summaries` | 29 | Clinical lifecycle against the live LLM |
| `verify:notifications` | 32 | Outbox delivery, retry, dead letters, concurrency |
| `verify:degradation` | 19 | Everything still works with the LLM broken |
| `verify:clinics` | 33 | Multi-tenant isolation |
| `smoke:part2` | 48 | Auth + admin API |

Highlights: eight simultaneous hold requests at one slot through real HTTP
(exactly one wins), four concurrent outbox workers dividing a queue without
double-sending, and fifteen cross-tenant attacks that must all 404.
