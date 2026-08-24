-- ===========================================================================
-- Double-booking prevention
-- ===========================================================================
-- A doctor may have many rows for the same (doctorId, slotStart) over time --
-- one CONFIRMED appointment that later gets CANCELLED, then a new booking for
-- the same slot. So a plain UNIQUE constraint is wrong: it would permanently
-- burn the slot after the first cancellation.
--
-- What must be unique is the set of *live* rows. A PARTIAL unique index over
-- the statuses that actually occupy a slot gives exactly that, and it is
-- enforced by Postgres itself -- two concurrent transactions inserting the
-- same slot cannot both commit, regardless of application-level checking.
--
-- HELD is included so the hold mechanism reserves the slot the instant the row
-- is written, closing the window between "patient picked a slot" and "patient
-- finished the symptom form".
--
-- The application catches the resulting error (Prisma P2002 / SQLSTATE 23505)
-- and maps it to HTTP 409 Conflict.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "appointments_active_slot_key"
  ON "appointments" ("doctorId", "slotStart")
  WHERE "status" IN ('HELD', 'CONFIRMED');

-- ===========================================================================
-- Overlap safety net
-- ===========================================================================
-- The index above keys on the exact slot start. If a doctor's slotDurationMin
-- is changed while future bookings exist, a new grid could produce a *different*
-- start time that still overlaps an existing appointment (e.g. 10:00-10:30
-- already booked, new grid offers 10:15-10:45). btree_gist + an EXCLUDE
-- constraint on the time range rules that out too.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "doctorId" WITH =,
    tsrange("slotStart", "slotEnd", '[)') WITH &&
  )
  WHERE ("status" IN ('HELD', 'CONFIRMED'));

-- ===========================================================================
-- Hold expiry lookup
-- ===========================================================================
-- The sweeper polls for HELD rows whose hold has lapsed. Partial index keeps it
-- cheap regardless of how large the appointments table grows.
-- ---------------------------------------------------------------------------

CREATE INDEX "appointments_expired_holds_idx"
  ON "appointments" ("holdExpiresAt")
  WHERE "status" = 'HELD';

-- ===========================================================================
-- Outbox worker claim path
-- ===========================================================================
-- The worker claims rows with FOR UPDATE SKIP LOCKED ordered by nextAttemptAt.
-- A partial index over only the drainable statuses keeps that scan small even
-- when the table is mostly SENT history.
-- ---------------------------------------------------------------------------

CREATE INDEX "notification_outbox_drainable_idx"
  ON "notification_outbox" ("nextAttemptAt")
  WHERE "status" IN ('PENDING', 'FAILED');

CREATE INDEX "medication_reminders_due_idx"
  ON "medication_reminders" ("scheduledAt")
  WHERE "status" = 'PENDING';
