/**
 * Removes accounts created by the verification suites, keeping only the seeded
 * demo data. Verification scripts create throwaway doctors and patients on every
 * run; left alone they clutter the directory and fill the FIFO summary queue.
 *
 *   node scripts/clean-test-data.js
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KEEP = new Set([
  'admin@clinic.test',
  'dr.mehta@clinic.test',
  'dr.rao@clinic.test',
  'dr.fernandes@clinic.test',
  'dr.khan@clinic.test',
  'patient.one@example.test',
  'patient.two@example.test',
  'patient.three@example.test',
]);

async function main() {
  const all = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  const doomed = all.filter((u) => !KEEP.has(u.email));

  if (doomed.length === 0) {
    console.log('Nothing to clean - only seeded accounts present.');
    return;
  }

  console.log(`Removing ${doomed.length} test account(s), keeping ${KEEP.size} seeded ones.`);

  const doomedIds = doomed.map((u) => u.id);

  // visit_notes.doctorId is RESTRICT, not CASCADE - deliberately, so signed
  // clinical notes cannot be orphaned by removing a doctor (the app soft-deletes
  // doctors instead). Test notes must therefore be cleared explicitly first.
  const notes = await prisma.visitNote.deleteMany({
    where: { doctor: { userId: { in: doomedIds } } },
  });

  // Cascades then handle profiles, appointments, summaries, reminders,
  // calendar rows and outbox entries.
  const { count } = await prisma.user.deleteMany({ where: { id: { in: doomedIds } } });
  console.log(`  deleted visit notes  : ${notes.count}`);

  // Outbox rows for deleted users keep a null recipientUserId (SetNull), so
  // sweep anything left pointing at a test address.
  const orphaned = await prisma.notificationOutbox.deleteMany({
    where: {
      OR: [
        { recipientEmail: { contains: '@probe.test' } },
        { recipientEmail: { startsWith: 'verify-' } },
        { recipientEmail: { startsWith: 'dbg' } },
      ],
    },
  });

  const [users, doctors, appts, pending, outbox] = await Promise.all([
    prisma.user.count(),
    prisma.doctorProfile.count(),
    prisma.appointment.count(),
    prisma.preVisitSummary.count({ where: { status: 'PENDING' } }),
    prisma.notificationOutbox.count({ where: { status: { in: ['PENDING', 'FAILED'] } } }),
  ]);

  console.log(`  deleted users        : ${count}`);
  console.log(`  orphaned outbox rows : ${orphaned.count}`);
  console.log('');
  console.log(`  remaining users      : ${users}`);
  console.log(`  remaining doctors    : ${doctors}`);
  console.log(`  remaining appointments: ${appts}`);
  console.log(`  pending summaries    : ${pending}`);
  console.log(`  queued notifications : ${outbox}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
