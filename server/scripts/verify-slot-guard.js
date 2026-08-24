/**
 * Concurrency proof for the double-booking guard.
 *
 * Fires N simultaneous INSERTs for the identical (doctor, slot) and asserts
 * that exactly one commits. Then fires N more for an OVERLAPPING but
 * non-identical range to prove the EXCLUDE constraint catches what the unique
 * index alone would miss.
 *
 * Run:  node scripts/verify-slot-guard.js
 */
import { PrismaClient } from '@prisma/client';
import { isSlotConflict } from '../src/lib/prisma.js';

const prisma = new PrismaClient();
const CONCURRENCY = 12;

function summarise(results) {
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const conflicts = results.filter(
    (r) => r.status === 'rejected' && isSlotConflict(r.reason)
  ).length;
  const other = results.filter(
    (r) => r.status === 'rejected' && !isSlotConflict(r.reason)
  );
  return { ok, conflicts, other };
}

async function main() {
  const doctor = await prisma.doctorProfile.findFirst({ include: { user: true } });
  const patients = await prisma.patientProfile.findMany({ take: 3 });
  if (!doctor || patients.length === 0) throw new Error('Run `npm run db:seed` first.');

  // A slot far in the future so it never collides with real data.
  const base = new Date('2099-06-01T10:00:00.000Z');
  const end = new Date(base.getTime() + 30 * 60_000);

  await prisma.appointment.deleteMany({ where: { slotStart: { gte: new Date('2099-01-01') } } });

  // -------------------------------------------------------------------------
  console.log(`\nTest 1: ${CONCURRENCY} concurrent bookings for the SAME slot`);
  console.log(`  doctor ${doctor.user.fullName}  slot ${base.toISOString()}`);

  const sameSlot = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      prisma.appointment.create({
        data: {
          doctorId: doctor.id,
          patientId: patients[i % patients.length].id,
          slotStart: base,
          slotEnd: end,
          status: 'HELD',
          holdExpiresAt: new Date(Date.now() + 600_000),
        },
      })
    )
  );

  const r1 = summarise(sameSlot);
  console.log(`  committed: ${r1.ok}   rejected as slot conflict: ${r1.conflicts}`);
  if (r1.other.length) console.log('  UNEXPECTED errors:', r1.other.map((o) => o.reason.message));
  console.log(r1.ok === 1 ? '  PASS - exactly one winner' : `  FAIL - ${r1.ok} winners`);

  // -------------------------------------------------------------------------
  console.log(`\nTest 2: ${CONCURRENCY} concurrent bookings OVERLAPPING that slot`);
  const overlapStart = new Date(base.getTime() + 15 * 60_000); // 10:15, overlaps 10:00-10:30
  const overlapEnd = new Date(overlapStart.getTime() + 30 * 60_000);
  console.log(`  slot ${overlapStart.toISOString()} (unique index would NOT catch this)`);

  const overlapping = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      prisma.appointment.create({
        data: {
          doctorId: doctor.id,
          patientId: patients[i % patients.length].id,
          slotStart: overlapStart,
          slotEnd: overlapEnd,
          status: 'HELD',
          holdExpiresAt: new Date(Date.now() + 600_000),
        },
      })
    )
  );

  const r2 = summarise(overlapping);
  console.log(`  committed: ${r2.ok}   rejected as slot conflict: ${r2.conflicts}`);
  if (r2.other.length) console.log('  UNEXPECTED errors:', r2.other.map((o) => o.reason.message));
  console.log(r2.ok === 0 ? '  PASS - all rejected, slot already occupied' : `  FAIL - ${r2.ok} leaked through`);

  // -------------------------------------------------------------------------
  console.log('\nTest 3: cancelling frees the slot for rebooking');
  await prisma.appointment.updateMany({
    where: { slotStart: base, status: 'HELD' },
    data: { status: 'CANCELLED', cancelledBy: 'PATIENT', cancelledAt: new Date() },
  });
  try {
    await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patients[0].id,
        slotStart: base,
        slotEnd: end,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });
    console.log('  PASS - slot rebookable after cancellation');
  } catch (e) {
    console.log('  FAIL - slot permanently burned:', e.message.split('\n')[0]);
  }

  const total = await prisma.appointment.count({
    where: { slotStart: { gte: new Date('2099-01-01') } },
  });
  console.log(`\n  rows left behind: ${total} (1 CANCELLED history + 1 CONFIRMED expected... cleaning up)`);
  await prisma.appointment.deleteMany({ where: { slotStart: { gte: new Date('2099-01-01') } } });
  console.log('  cleaned up\n');
}

main()
  .catch((e) => {
    console.error('verification failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
