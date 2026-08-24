# Healthcare Appointment & Follow-up Manager

Appointment platform for a clinic with three portals (patient / doctor / admin),
AI-generated pre-visit and post-visit summaries, email notifications, and Google
Calendar sync.

> **Build status — Parts 1–4 of 8 complete, verified against a live database and a live LLM.**
> Foundation: database schema, migrations, seed data, config, error handling,
> health endpoints. Remaining parts listed under [Roadmap](#roadmap).

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Node.js 20+ / Express | Matches the Nodemailer + free-tier hosting path |
| ORM | Prisma + PostgreSQL | Declarative schema doubles as documentation; real migrations |
| Auth | JWT access + refresh, role-based | Three distinct portals |
| LLM | Provider-agnostic adapter — **Gemini** (`gemini-3.6-flash`), Groq, OpenRouter, mock | Free tiers; swap with one env var |
| Email | Nodemailer (console transport in dev) | Works with any SMTP provider |
| Jobs | DB-backed outbox + polling worker | No Redis, so free hosting tiers work |
| Calendar | Google Calendar API, OAuth 2.0 | Required by spec |
| Frontend | React + Vite | — |

---

## Prerequisites

- Node.js 20 or newer
- PostgreSQL 14+ (either Docker, or an existing local server)

---

## Setup

```bash
cd server
npm install
cp .env.example .env
```

### Database

The repo ships a `docker-compose.yml` that runs Postgres on **port 5433**, so it
will not collide with an existing local server on 5432:

```bash
docker compose up -d
```

If you would rather use an existing PostgreSQL server, create a database and
point `DATABASE_URL` in `server/.env` at it instead.

Then apply migrations and load sample data:

```bash
cd server && npx prisma migrate deploy && npm run db:seed
```

### Run

```bash
cd server && npm run dev
```

- `GET /health` — liveness
- `GET /health/ready` — readiness, reports which subsystems are degraded

---

## Seeded accounts

All seeded users share the password `Password123!`.

| Role | Email |
|---|---|
| Admin | `admin@clinic.test` |
| Doctor | `dr.mehta@clinic.test` (General Medicine, 30-min slots) |
| Doctor | `dr.rao@clinic.test` (Cardiology, 45-min slots + 15-min buffer) |
| Doctor | `dr.fernandes@clinic.test` (Dermatology, 20-min slots) |
| Doctor | `dr.khan@clinic.test` (Pediatrics, 15-min slots) |
| Patient | `patient.one@example.test` |
| Patient | `patient.two@example.test` |
| Patient | `patient.three@example.test` |

---

## Database schema

17 models. The ones carrying the load:

- **`appointments`** — the concurrency-critical table. Guarded by a *partial
  unique index* on `(doctorId, slotStart) WHERE status IN ('HELD','CONFIRMED')`
  plus a `btree_gist` **EXCLUDE** constraint that rejects any overlapping time
  range for the same doctor. Both live in
  `prisma/migrations/20250101000001_active_slot_guard/migration.sql`. A plain
  unique constraint would have been wrong — it would permanently burn a slot
  after its first cancellation.
- **`notification_outbox`** — transactional outbox. Rows are written in the same
  transaction as the business change and drained by a worker with exponential
  backoff, a `dedupeKey` for idempotency, and a `DEAD` terminal state.
- **`pre_visit_summaries` / `post_visit_summaries`** — LLM output with an
  explicit `PENDING → READY / FAILED` lifecycle, attempt counter, and stored
  provenance (provider, model, prompt version, raw response), so a provider
  outage degrades one field rather than failing the booking.
- **`calendar_events`** — one row per (appointment, participant) with its own
  sync status, so a failed Google call is retryable without losing the remote
  event id.

### Verifying the concurrency guarantee

```bash
cd server && npm run verify:slots
```

Fires 12 simultaneous inserts at one slot and asserts exactly one commits, then
12 more at an *overlapping* range to show the EXCLUDE constraint catches what the
unique index alone cannot, then confirms a cancelled slot becomes rebookable.

Current result:

```
Test 1: 12 concurrent bookings for the SAME slot
  committed: 1   rejected as slot conflict: 11        PASS
Test 2: 12 concurrent bookings OVERLAPPING that slot
  committed: 0   rejected as slot conflict: 12        PASS
Test 3: cancelling frees the slot for rebooking       PASS
```

---

## API — implemented so far

### Auth (`/api/auth`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/register` | — | Patient self-registration (role is not accepted from the client) |
| POST | `/login` | — | Returns access + refresh tokens |
| POST | `/refresh` | — | Rotates the refresh token |
| POST | `/logout` | — | Revokes one refresh token |
| POST | `/logout-all` | any | Revokes every session |
| GET | `/me` | any | Profile incl. role-specific part |
| PATCH | `/me` | any | Update name / phone / timezone |
| POST | `/change-password` | any | Revokes all sessions on success |

### Admin (`/api/admin`) — ADMIN only

| Method | Path | Purpose |
|---|---|---|
| POST | `/doctors` | Create doctor (user + profile + working hours, one transaction) |
| GET | `/doctors` | List, filter by specialisation / free text / active, paginated |
| GET | `/doctors/:id` | Detail |
| PATCH | `/doctors/:id` | Update profile or scheduling config |
| DELETE | `/doctors/:id` | Deactivate (soft — appointments reference the row) |
| PUT | `/doctors/:id/working-hours` | Replace the weekly schedule |
| POST | `/doctors/:id/leaves/preview` | **Dry run** — what a leave would cancel, writes nothing |
| POST | `/doctors/:id/leaves` | Create leave + cascade |
| GET | `/doctors/:id/leaves` | List, optional `from`/`to` |
| DELETE | `/doctors/:id/leaves/:leaveId` | Remove a leave |

### Appointments (`/api/appointments`) — signed in

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/hold` | patient | **Step 1** — reserve a slot with a TTL |
| POST | `/:id/confirm` | patient | **Step 2** — submit symptom form, confirm |
| DELETE | `/:id/hold` | patient | Give up a hold early |
| GET | `/` | any | List, scoped to caller's role |
| GET | `/:id` | participants | Detail (pre-visit summary is doctor/admin only) |
| POST | `/:id/cancel` | participants | Cancel + notify both sides |
| POST | `/:id/reschedule` | participants | Move to a new slot |
| POST | `/expire-holds` | admin | Manually trigger the sweeper |

### Clinical summaries (`/api/appointments/:id`) — signed in

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/pre-visit-summary` | doctor, admin | Triage summary + raw symptom text |
| GET | `/post-visit-summary` | participants | Plain-language summary for the patient |
| POST | `/visit-note` | attending doctor | Notes + prescription → schedules reminders |
| POST | `/pre-visit-summary/regenerate` | doctor, admin | Manual retry after a failure |
| POST | `/post-visit-summary/regenerate` | doctor, admin | Manual retry after a failure |

The pre-visit summary is **never** returned to patients — an "urgency: HIGH"
label with no clinician to interpret it does harm rather than good.

### Doctor directory (`/api/doctors`) — any signed-in user

| Method | Path | Purpose |
|---|---|---|
| GET | `/specialisations` | Distinct list with doctor counts |
| GET | `/` | Search by specialisation or free text |
| GET | `/:id` | Public profile + upcoming leave days |
| GET | `/:id/availability` | Computed slots for a date or range |

Inactive doctors are invisible here, and licence numbers and doctor email
addresses are never exposed to patients.

---

## Security notes

- **Refresh tokens rotate.** Only a SHA-256 hash is stored. Redeeming one
  revokes it and issues a new pair; presenting an already-redeemed token is
  treated as theft and revokes *every* session for that user.
- **Registration cannot escalate.** `role` is absent from the register schema —
  doctors and admins are only ever provisioned by an admin.
- **Login is timing-safe** against user enumeration: a bcrypt comparison runs
  against a dummy hash when the email is unknown.
- Credential endpoints have their own rate limiter (10 failed attempts / 15 min)
  separate from the global API limit.

---

## How booking works

Booking is deliberately **two-phase**, because the spec requires a symptom form
*before* confirmation — and a patient filling in a form is a multi-minute window
in which somebody else can take the slot.

```
POST /appointments/hold      -> HELD row written immediately (TTL 10 min)
      patient fills symptom form
POST /appointments/:id/confirm -> HELD -> CONFIRMED, symptoms + summary + emails
```

Writing the `HELD` row up front means the slot occupies the partial unique index
from the first click, so the second patient is rejected at *hold* time rather
than after they have filled in the whole form.

**Availability is computed, never stored.** A materialised slot table would need
regenerating whenever a doctor edits their hours and would drift the moment that
job failed. A slot exists iff it survives four filters: inside an active working
block, not overlapping leave, not overlapping a `HELD`/`CONFIRMED` appointment,
and within the notice/advance window.

**Lapsed holds are reaped inline, not only by the sweeper.** `holdSlot` clears
expired holds for the exact slot it is about to write, so an abandoned hold never
blocks a booking even if the background sweeper is down. The sweeper is hygiene,
not correctness.

**Reschedule is cancel-old + create-new in one transaction**, not an `UPDATE` of
`slotStart`. If the target slot is taken, the constraint violation rolls
everything back and the original booking survives — rather than being destroyed
by a move that then failed.

---

## LLM integration

Two versioned prompts, both keeping the task wording from the brief and adding a
strict output contract, explicit scope limits, and an instruction to work only
from supplied text.

| Prompt | Audience | Output |
|---|---|---|
| `previsit-v1` | doctor | urgency (LOW/MEDIUM/HIGH), chief complaint, 3 questions |
| `postvisit-v1` | patient | plain-language summary, medication schedule, follow-up, warning signs |

Real output from `gemini-3.6-flash`, for symptoms *"crushing chest pain
radiating to my left arm… sweating and shortness of breath"*:

> **urgency:** HIGH — *"acute onset of severe (9/10) crushing chest pain
> radiating to the left arm… associated with diaphoresis and dyspnea, on a
> background of hypertension."*

And post-visit, turning `"dysuria… +ve nitrites"` into *"painful urination… a
urine test showed signs of a lower urinary tract infection"*, with
`TWICE_DAILY` rendered as `["morning","night"]`.

### Why generation is asynchronous

Measured latency on the free tier: **4–14 seconds** typically, and **129
seconds** once on an overloaded model alias. No user-facing request waits on
that. Confirming a booking writes a `PENDING` summary row and returns
immediately; a background worker fills it in.

### Failure handling

| Failure | Response |
|---|---|
| Provider hangs | `AbortController` timeout at `LLM_TIMEOUT_MS` |
| 429 / 5xx / network | Retried with exponential backoff + jitter |
| 400 / 401 / 404 / safety block | Fails immediately — retrying burns quota |
| Non-JSON or wrong shape | Retried (usually a sampling artefact), then parked |
| Retries exhausted | Row parked `FAILED` with `lastError`; nothing else affected |

Provenance — provider, model, prompt version, token count, latency, raw
response — is stored on every summary, so a bad result can be traced to a bad
model or a bad prompt.

**Nothing in the booking path depends on the LLM succeeding.** Proven under a
deliberately invalid API key: booking, confirmation, visit notes, medication
reminders and appointment completion all still work, and the doctor still sees
the raw symptom text.

---

## Verification

```bash
cd server && npm run verify:all
```

| Suite | Checks | Covers |
|---|---|---|
| `verify:slots` | 3 | DB-level concurrency guards |
| `verify:leave` | 14 | Leave conflict cascade |
| `verify:booking` | 53 | Full booking lifecycle over HTTP |
| `verify:holds` | 11 | Hold TTL, inline reaping, sweeper |
| `verify:summaries` | 29 | Full clinical lifecycle against the live LLM |
| `verify:degradation` | 19 | Everything still works with the provider broken |
| `smoke:part2` | 48 | Auth + admin API |

**177 checks, all passing.** The booking suite fires 8 simultaneous hold
requests at one slot through the real HTTP API and asserts exactly one returns
201 while the other seven get `409 SLOT_UNAVAILABLE`. The degradation suite runs
the same flows with a deliberately invalid API key.

---

## Roadmap

| Part | Scope | Status |
|---|---|---|
| 1 | Scaffold, DB schema, migrations, seed, config | done — verified |
| 2 | Auth (JWT + RBAC), admin doctor management | done — verified |
| 3 | Slot generation, holds, race-safe booking | done — verified |
| 4 | LLM adapter, pre/post-visit summaries, degradation | done — verified |
| 5 | Notification outbox, email worker, medication reminders | pending |
| 6 | Google Calendar OAuth + event sync | pending |
| 7 | React frontend (three portals) | pending |
| 8 | API docs, system design write-up, deployment | pending |
"# Unthinkable_Health_Appointment_Manager" 
