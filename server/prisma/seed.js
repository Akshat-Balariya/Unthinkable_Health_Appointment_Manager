/**
 * Development seed.
 *
 * Creates one admin, four doctors across different specialisations (each with
 * working hours), and three patients. Idempotent - re-running upserts by email
 * rather than duplicating.
 *
 * Run with:  npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PASSWORD = 'Password123!';

// Monday-Friday, two blocks a day.
const WEEKDAY_HOURS = [1, 2, 3, 4, 5].flatMap((dayOfWeek) => [
  { dayOfWeek, startTime: '09:00', endTime: '13:00' },
  { dayOfWeek, startTime: '16:00', endTime: '19:00' },
]);

// Saturday morning only.
const SATURDAY_HOURS = [{ dayOfWeek: 6, startTime: '10:00', endTime: '13:00' }];

const DOCTORS = [
  {
    email: 'dr.mehta@clinic.test',
    fullName: 'Dr. Anjali Mehta',
    specialisation: 'General Medicine',
    qualifications: 'MBBS, MD (Internal Medicine)',
    slotDurationMin: 30,
    consultationFee: 600,
    hours: [...WEEKDAY_HOURS, ...SATURDAY_HOURS],
  },
  {
    email: 'dr.rao@clinic.test',
    fullName: 'Dr. Vikram Rao',
    specialisation: 'Cardiology',
    qualifications: 'MBBS, DM (Cardiology)',
    slotDurationMin: 45,
    bufferMin: 15,
    consultationFee: 1500,
    hours: WEEKDAY_HOURS,
  },
  {
    email: 'dr.fernandes@clinic.test',
    fullName: 'Dr. Clara Fernandes',
    specialisation: 'Dermatology',
    qualifications: 'MBBS, MD (Dermatology)',
    slotDurationMin: 20,
    consultationFee: 800,
    hours: [...WEEKDAY_HOURS, ...SATURDAY_HOURS],
  },
  {
    email: 'dr.khan@clinic.test',
    fullName: 'Dr. Imran Khan',
    specialisation: 'Pediatrics',
    qualifications: 'MBBS, DCH',
    slotDurationMin: 15,
    consultationFee: 700,
    hours: WEEKDAY_HOURS,
  },
];

const PATIENTS = [
  {
    email: 'patient.one@example.test',
    fullName: 'Riya Sharma',
    dateOfBirth: '1994-04-12',
    gender: 'Female',
    bloodGroup: 'O+',
    allergies: 'Penicillin',
  },
  {
    email: 'patient.two@example.test',
    fullName: 'Arjun Nair',
    dateOfBirth: '1988-11-02',
    gender: 'Male',
    bloodGroup: 'B+',
    chronicConditions: 'Type 2 diabetes',
  },
  {
    email: 'patient.three@example.test',
    fullName: 'Meera Iyer',
    dateOfBirth: '2001-07-25',
    gender: 'Female',
    bloodGroup: 'A-',
  },
];

async function upsertUser({ email, fullName, role, phone }) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return prisma.user.upsert({
    where: { email },
    update: { fullName, role, phone },
    create: { email, fullName, role, phone, passwordHash },
  });
}

async function main() {
  console.log('Seeding database...');

  // --- admin ---------------------------------------------------------------
  const admin = await upsertUser({
    email: 'admin@clinic.test',
    fullName: 'Clinic Administrator',
    role: 'ADMIN',
    phone: '+91-98000-00000',
  });
  console.log(`  admin    ${admin.email}`);

  // --- doctors -------------------------------------------------------------
  for (const d of DOCTORS) {
    const user = await upsertUser({
      email: d.email,
      fullName: d.fullName,
      role: 'DOCTOR',
      phone: '+91-98000-00001',
    });

    const doctor = await prisma.doctorProfile.upsert({
      where: { userId: user.id },
      update: {
        specialisation: d.specialisation,
        qualifications: d.qualifications,
        slotDurationMin: d.slotDurationMin,
        bufferMin: d.bufferMin ?? 0,
        consultationFee: d.consultationFee,
      },
      create: {
        userId: user.id,
        specialisation: d.specialisation,
        qualifications: d.qualifications,
        slotDurationMin: d.slotDurationMin,
        bufferMin: d.bufferMin ?? 0,
        consultationFee: d.consultationFee,
        bio: `${d.fullName} practises ${d.specialisation.toLowerCase()} at the clinic.`,
      },
    });

    // Replace working hours wholesale so re-seeding stays deterministic.
    await prisma.doctorWorkingHour.deleteMany({ where: { doctorId: doctor.id } });
    await prisma.doctorWorkingHour.createMany({
      data: d.hours.map((h) => ({ ...h, doctorId: doctor.id })),
    });

    console.log(
      `  doctor   ${d.email}  (${d.specialisation}, ${d.slotDurationMin}min slots, ${d.hours.length} blocks)`
    );
  }

  // --- patients ------------------------------------------------------------
  for (const p of PATIENTS) {
    const user = await upsertUser({
      email: p.email,
      fullName: p.fullName,
      role: 'PATIENT',
      phone: '+91-99000-00002',
    });

    await prisma.patientProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        dateOfBirth: p.dateOfBirth ? new Date(p.dateOfBirth) : null,
        gender: p.gender,
        bloodGroup: p.bloodGroup,
        allergies: p.allergies,
        chronicConditions: p.chronicConditions,
      },
    });
    console.log(`  patient  ${p.email}`);
  }

  console.log(`\nDone. All seeded accounts use the password:  ${PASSWORD}\n`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
