# Database Schema

PostgreSQL via Prisma. 18 models. Full definition:
[`server/prisma/schema.prisma`](../server/prisma/schema.prisma).

## Entity map

```
Clinic ──< User (CLINIC_ADMIN)
   └────< DoctorProfile ──< DoctorWorkingHour
                        ├──< DoctorLeave
                        └──< Appointment >── PatientProfile ──< User
                                │
                                ├── SymptomReport      (1:1)
                                ├── PreVisitSummary    (1:1, LLM)
                                ├── VisitNote          (1:1) ──< PrescriptionItem ──< MedicationReminder
                                ├── PostVisitSummary   (1:1, LLM)
                                ├──< CalendarEvent     (one per participant)
                                └──< NotificationOutbox
```

## Tables

| Table | Purpose |
|---|---|
| `clinics` | Tenant. Owns doctors; administered by its own `CLINIC_ADMIN` users |
| `users` | Identity + role (`PATIENT`/`DOCTOR`/`CLINIC_ADMIN`/`ADMIN`) |
| `refresh_tokens` | SHA-256 hashes only; rotated on use |
| `patient_profiles` | Demographics, allergies, chronic conditions |
| `doctor_profiles` | Specialisation, fee, and scheduling config |
| `doctor_working_hours` | Recurring weekly availability blocks |
| `doctor_leaves` | Full-day or partial absences |
| `appointments` | **Concurrency-critical.** See guards below |
| `symptom_reports` | Patient's pre-visit form; LLM input |
| `pre_visit_summaries` | LLM triage output for the doctor |
| `visit_notes` | Doctor's clinical notes |
| `prescription_items` | One row per prescribed medication |
| `post_visit_summaries` | LLM plain-language output for the patient |
| `medication_reminders` | One row per dose occurrence |
| `notification_outbox` | Transactional outbox for all email |
| `calendar_accounts` | Google OAuth tokens, encrypted at rest |
| `calendar_events` | Sync state per (appointment, participant) |
| `audit_logs` | Who did what, to which entity |

## Key design decisions

**Slots are absolute UTC instants.** `appointments.slotStart/slotEnd` are UTC.
Working hours and leave times are wall-clock strings (`"09:00"`) in the clinic
timezone — they are not instants and must never be stored as such. All conversion
goes through `src/lib/time.js`, so DST is handled in one place.

**Double-booking guards** (migration `20250101000001_active_slot_guard`):

```sql
CREATE UNIQUE INDEX appointments_active_slot_key
  ON appointments ("doctorId", "slotStart")
  WHERE status IN ('HELD','CONFIRMED');

ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist ("doctorId" WITH =, tsrange("slotStart","slotEnd",'[)') WITH &&)
  WHERE (status IN ('HELD','CONFIRMED'));
```

The index is **partial** because a plain unique constraint would permanently burn
a slot after its first cancellation. The EXCLUDE constraint catches overlapping —
not merely identical — ranges, which matters when a doctor's slot duration changes
with bookings live.

**`HELD` occupies the index**, which is what makes the two-phase booking safe: the
slot is reserved from the first click, not after the symptom form is submitted.

**LLM output carries a lifecycle and provenance.** Both summary tables have
`status` (`PENDING`/`READY`/`FAILED`), `attempts`, `lastError`, plus `provider`,
`model`, `promptVersion`, `rawResponse`, `tokensUsed`, `latencyMs`. A bad summary
can be traced to a bad model *or* a bad prompt, and a provider outage degrades one
field rather than failing the booking.

**`notification_outbox` is written in the same transaction as the business
change.** `dedupeKey` is unique, making enqueueing idempotent. Statuses:
`PENDING → PROCESSING → SENT`, or `FAILED` (retryable, with `nextAttemptAt`) or
`DEAD` (exhausted, needs a human). `CANCELLED` marks events superseded before
sending — a reminder for a cancelled appointment.

**Reminders are materialised, one row per dose.** `TWICE_DAILY × 30 days` = 60
rows. Costlier than a recurrence rule, but each dose is individually retryable and
cancellable, and "did we send this?" is a primary-key lookup.

**`visit_notes.doctorId` is `RESTRICT`, not `CASCADE`** — deliberately. Signed
clinical notes must not be orphaned by deleting a doctor, which is why the
application soft-deletes doctors instead.

**Multi-tenancy** is `clinicId` on `doctor_profiles` and `users`. The scope comes
from the verified JWT, never the request body.

## Partial indexes

Beyond the guards, several indexes are partial so hot paths stay cheap as history
accumulates:

| Index | Predicate |
|---|---|
| `appointments_expired_holds_idx` | `status = 'HELD'` |
| `notification_outbox_drainable_idx` | `status IN ('PENDING','FAILED')` |
| `medication_reminders_due_idx` | `status = 'PENDING'` |

## Migrations

| Migration | Contents |
|---|---|
| `20250101000000_init` | Baseline: all tables, enums, indexes |
| `20250101000001_active_slot_guard` | Partial unique index, EXCLUDE constraint, partial indexes |
| `20250101000002_clinics` | `clinics` table, `clinicId` columns, `CLINIC_ADMIN` role |

```bash
cd server && npx prisma migrate deploy
```
