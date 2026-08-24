# API Reference

Base URL: `http://localhost:4000`. All bodies are JSON.

## Conventions

**Auth** — `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes;
refresh with `POST /api/auth/refresh`.

**Errors** — every failure returns the same envelope:

```json
{ "error": { "code": "SLOT_UNAVAILABLE", "message": "That slot has just been taken.", "details": [] } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` (with per-field `details`) |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `SLOT_UNAVAILABLE` |
| 429 | `RATE_LIMITED` |
| 503 | `CALENDAR_DISABLED` |

**Pagination** — list endpoints accept `page` and `limit` and return
`{ data, pagination: { page, limit, total, totalPages } }`.

**Roles** — `PATIENT`, `DOCTOR`, `CLINIC_ADMIN`, `ADMIN`.

---

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/health/ready` | Readiness; reports database, LLM provider, mail transport, calendar |

---

## Auth — `/api/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/register` | — | Patient self-registration |
| POST | `/login` | — | Returns user + tokens |
| POST | `/refresh` | — | Rotates the refresh token |
| POST | `/logout` | — | Revokes one refresh token |
| POST | `/logout-all` | any | Revokes every session |
| GET | `/me` | any | Profile incl. role-specific data |
| PATCH | `/me` | any | Update name, phone, timezone |
| POST | `/change-password` | any | Revokes all sessions on success |

`POST /register` — `role` is **not accepted**; public registration always creates
a patient.

```json
{ "email": "riya@example.com", "password": "Passw0rdTest", "fullName": "Riya Sharma",
  "phone": "+91…", "dateOfBirth": "1994-04-12", "gender": "Female",
  "bloodGroup": "O+", "allergies": "Penicillin" }
```

Response `201`:

```json
{ "user": { "id": "…", "email": "…", "role": "PATIENT", "fullName": "…" },
  "tokens": { "accessToken": "…", "refreshToken": "…", "expiresIn": 900 } }
```

Credential endpoints allow 10 failed attempts per 15 minutes.

---

## Clinics — `/api/clinics`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/register` | — | Clinic signup: creates clinic + first `CLINIC_ADMIN` |
| GET | `/` | — | Public clinic directory |
| GET | `/me` | clinic admin | Own clinic + doctor count |
| PATCH | `/me` | clinic admin | Update clinic details |

```json
{ "name": "Riverside Medical Centre", "clinicEmail": "contact@riverside.test",
  "phone": "+91…", "addressLine": "22 River Road", "city": "Kochi",
  "adminName": "Dr Priya Nair", "adminEmail": "priya@riverside.test",
  "password": "Passw0rdTest" }
```

The role is hardcoded to `CLINIC_ADMIN`; a `role` field in the body is ignored.
Limited to 20 registrations per hour.

---

## Doctor management — `/api/admin`

`CLINIC_ADMIN` (scoped to its own clinic) or `ADMIN` (unscoped).

| Method | Path | Purpose |
|---|---|---|
| POST | `/doctors` | Create doctor: user + profile + working hours, one transaction |
| GET | `/doctors` | List; filters `specialisation`, `q`, `isActive` |
| GET | `/doctors/:id` | Detail |
| PATCH | `/doctors/:id` | Update profile or scheduling config |
| DELETE | `/doctors/:id` | Deactivate (soft) |
| PUT | `/doctors/:id/working-hours` | Replace the weekly schedule |
| POST | `/doctors/:id/leaves/preview` | **Dry run** — what a leave would cancel |
| POST | `/doctors/:id/leaves` | Create leave + cascade |
| GET | `/doctors/:id/leaves` | List; optional `from`, `to` |
| DELETE | `/doctors/:id/leaves/:leaveId` | Remove a leave |

Create doctor:

```json
{ "email": "dr.x@clinic.test", "password": "Passw0rdTest", "fullName": "Dr X",
  "specialisation": "Cardiology", "qualifications": "MBBS, DM",
  "consultationFee": 1500, "slotDurationMin": 45, "bufferMin": 15,
  "maxAdvanceDays": 30, "minNoticeMin": 60,
  "workingHours": [ { "dayOfWeek": 1, "startTime": "09:00", "endTime": "13:00" } ] }
```

`dayOfWeek` is 0=Sunday…6=Saturday. Overlapping blocks on the same day are
rejected at validation.

Leave cascade response:

```json
{ "leave": { "id": "…", "leaveDate": "2026-09-14" },
  "affected": [ { "appointmentId": "…", "slotStart": "…", "patientName": "…" } ],
  "notificationsQueued": 4 }
```

A doctor outside the caller's clinic returns **404**, not 403, so ids cannot be
probed across tenants.

---

## Doctor directory — `/api/doctors`

Any signed-in user. Inactive doctors are hidden; licence numbers and doctor email
addresses are never exposed.

| Method | Path | Purpose |
|---|---|---|
| GET | `/specialisations` | Distinct list with counts |
| GET | `/` | Search; filters `specialisation`, `clinicId`, `q` |
| GET | `/:id` | Public profile + upcoming leave days |
| GET | `/:id/availability` | Computed slots; `?date=` or `?from=&to=` |

Availability response:

```json
{ "doctorId": "…", "timezone": "Asia/Kolkata", "slotDurationMin": 30,
  "days": [ { "date": "2026-08-25", "onLeave": false,
    "slots": [ { "start": "2026-08-25T03:30:00.000Z", "end": "…", "localTime": "09:00" } ] } ] }
```

Slots are advisory — another patient may take one before you hold it, which is
what a `409` from `/appointments/hold` means.

---

## Appointments — `/api/appointments`

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/hold` | patient | **Step 1** — reserve a slot with a TTL |
| POST | `/:id/confirm` | patient | **Step 2** — symptom form, confirm |
| DELETE | `/:id/hold` | patient | Release a hold early |
| GET | `/` | any | List, scoped to the caller's role |
| GET | `/:id` | participants | Detail |
| POST | `/:id/cancel` | participants | Cancel + notify both sides |
| POST | `/:id/reschedule` | participants | Move to a new slot |
| POST | `/expire-holds` | admin | Run the sweeper now |

**Step 1** `POST /hold`:

```json
{ "doctorId": "…", "slotStart": "2026-08-25T03:30:00.000Z", "reasonForVisit": "optional" }
```

`201` returns the appointment with `status: "HELD"` and `holdExpiresInSeconds`.
`409 SLOT_UNAVAILABLE` means someone else won the race. A patient may hold at most
three slots at once.

**Step 2** `POST /:id/confirm`:

```json
{ "symptomsText": "Sharp pain in my lower right abdomen since yesterday…",
  "durationDays": 2, "severity": 7,
  "existingConditions": "", "currentMedications": "" }
```

`symptomsText` must be 10–4000 characters. Confirming returns immediately; the AI
summary is generated in the background. A lapsed hold returns `409`.

`GET /` filters: `status`, `upcoming=true`, `from`, `to`. The scope is derived
from the token — patients see their own, doctors theirs, admins everything.

---

## Clinical summaries — `/api/appointments/:id`

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/pre-visit-summary` | doctor, admin | Triage summary + raw symptom text |
| GET | `/post-visit-summary` | participants | Plain-language summary |
| POST | `/visit-note` | attending doctor | Notes + prescription |
| POST | `/pre-visit-summary/regenerate` | doctor, admin | Manual retry |
| POST | `/post-visit-summary/regenerate` | doctor, admin | Manual retry |

The pre-visit summary is **never** returned to patients — an "urgency: HIGH" label
with no clinician to interpret it does harm.

Pre-visit response:

```json
{ "status": "READY", "urgencyLevel": "HIGH",
  "chiefComplaint": "Acute onset of severe (9/10) crushing chest pain…",
  "suggestedQuestions": ["…", "…", "…"],
  "model": "gemini-3.6-flash", "promptVersion": "previsit-v1", "attempts": 1,
  "symptomReport": { "symptomsText": "…", "severity": 9 } }
```

`status` is `PENDING`, `READY` or `FAILED`. **The raw `symptomReport` is always
returned**, so the doctor is never left with nothing when the model is
unavailable.

`POST /visit-note`:

```json
{ "clinicalNotes": "Pt c/o unilateral throbbing cephalalgia x4/7…",
  "diagnosis": "Migraine without aura", "advice": "…", "followUpDate": "2026-09-25",
  "prescriptions": [ { "medicationName": "Propranolol", "dosage": "40 mg",
    "frequency": "TWICE_DAILY", "durationDays": 30, "instructions": "with food" } ] }
```

`frequency`: `ONCE_DAILY`, `TWICE_DAILY`, `THRICE_DAILY`, `FOUR_TIMES_DAILY`,
`EVERY_OTHER_DAY`, `WEEKLY`, `AS_NEEDED`. Submitting marks the appointment
`COMPLETED` and materialises one reminder row per dose. `AS_NEEDED` generates
none.

---

## Google Calendar — `/api/calendar`

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Whether the server and this user are connected |
| GET | `/google/connect` | Returns the consent URL |
| GET | `/google/callback` | Google redirects here, then back to the client |
| DELETE | `/google` | Revoke at Google and delete locally |
| POST | `/sync` | Run a sync pass now |

Returns `503 CALENDAR_DISABLED` when the server has no Google credentials. Users
who never connect are a silent no-op — calendar failures never block booking.

---

## Notification queue — `/api/admin/notifications`

Platform `ADMIN` only.

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats` | Outbox counts by status and type, plus reminder counts |
| GET | `/` | List; filters `status`, `type` |
| POST | `/retry` | Requeue dead letters (`ids` or `type`) |
| POST | `/drain` | Run a reminder + outbox pass now |

Dead letters are **not** retried automatically — a `DEAD` row usually means
something needs fixing first, so retrying on a schedule would just re-fail.
