# System Design

Healthcare Appointment & Follow-up Manager — Node/Express, PostgreSQL (Prisma),
React. Multi-tenant: clinics own doctors; patients search across all clinics.

## Double-booking prevention

Application-level "check then insert" cannot be correct under concurrency: two
requests can both read an empty slot before either writes. The guarantee
therefore lives in the database.

A **partial unique index** on `(doctorId, slotStart) WHERE status IN
('HELD','CONFIRMED')` makes a live booking unique. It is partial for a reason — a
plain unique constraint would permanently burn a slot after its first
cancellation, since the cancelled row would keep occupying the key. Only rows
that actually hold a slot participate.

The exact start time is not sufficient on its own. If a doctor's `slotDurationMin`
changes while future bookings exist, a regenerated grid can produce a *different*
start that still overlaps an existing appointment (10:00–10:30 booked, new grid
offers 10:15–10:45). A `btree_gist` **EXCLUDE** constraint on
`(doctorId WITH =, tsrange(slotStart, slotEnd) WITH &&)`, filtered to the same
live statuses, rejects that too.

Both are enforced by Postgres, so concurrent transactions cannot both commit. The
application catches the violation and returns `409 SLOT_UNAVAILABLE`. Verified by
firing eight simultaneous holds at one slot through HTTP: exactly one succeeds.

## Slot hold mechanism

The brief requires a symptom form *before* confirmation. That form takes minutes,
during which the slot must not be winnable by someone else. Booking is therefore
two-phase.

`POST /appointments/hold` writes the appointment immediately as `HELD` with a
`holdExpiresAt` TTL (default 10 minutes). Because `HELD` participates in the
unique index, the slot is reserved from the first click — the second patient is
rejected at *hold* time rather than after completing the whole form.
`POST /appointments/:id/confirm` then flips `HELD → CONFIRMED` under a
`where: { id, status: 'HELD' }` guard, so a hold that lapsed mid-form fails
cleanly instead of resurrecting.

Expiry is handled in two places. A background sweeper moves lapsed holds to
`EXPIRED`, and — more importantly — `holdSlot` reaps expired holds for the exact
slot it is about to write. Correctness does not depend on the sweeper running: an
abandoned hold never blocks a booking even if the worker is down. Holds are also
capped at three per patient to prevent slot-squatting.

Availability itself is **computed, never stored**. A materialised slot table would
need regenerating whenever a doctor edits their hours and would drift the moment
that job failed.

## Doctor leave conflict handling

Marking leave can invalidate a day of existing bookings, so it is a cascade, not a
flag. In **one transaction**: the leave row is created; every overlapping
`HELD`/`CONFIRMED` appointment is cancelled; a notification is queued per affected
patient plus a digest to the doctor; and reminders already queued for those
appointments are superseded. There is no window in which appointments are
cancelled but nobody was told.

Because bulk cancellation is destructive, `POST /leaves/preview` performs the same
conflict query and writes nothing, so an admin sees exactly who is affected before
committing. Deleting a leave does not resurrect appointments — patients were
already told, and those slots may since have been taken.

Overlap uses the half-open test `slotStart < rangeEnd AND slotEnd > rangeStart`,
so an appointment ending exactly when leave begins does not conflict.

## Notification failure handling

Nothing is sent inline. Every side effect is written to a **transactional outbox**
in the same transaction as the business change, so it is impossible to cancel an
appointment without queuing its notification, or to queue one for a change that
rolled back.

A worker drains the outbox using `FOR UPDATE SKIP LOCKED`, which lets multiple
workers divide the queue rather than serialise or duplicate. The attempt counter
increments at *claim* time, so a worker that crashes mid-send burns an attempt
rather than retrying forever. Failures back off quadratically (1m, 4m, 9m…);
permanent failures — invalid recipients, 5xx SMTP — skip retries entirely. After
`maxAttempts` a row becomes `DEAD` and is visible and requeueable through an admin
endpoint, because a dead-letter queue nobody can see is a silent failure.

A `dedupeKey` on the natural business event makes enqueueing idempotent, so a
retried request cannot double-send. Medication reminders are materialised as one
row per dose and promoted into the outbox when due, inheriting all of the above;
doses missed beyond a six-hour grace window are abandoned rather than sent
misleadingly late.

**LLM failures degrade rather than propagate.** Summaries are generated
asynchronously (measured latency 4–14s, once 129s) into rows with an explicit
`PENDING → READY/FAILED` lifecycle. A provider outage costs one field: booking,
confirmation, visit notes and reminders all still work, and the doctor still sees
the patient's raw symptom text. Verified end-to-end with a deliberately invalid
API key.
