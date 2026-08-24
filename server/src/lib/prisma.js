import { PrismaClient } from '@prisma/client';
import { isDev, isTest } from '../config/env.js';

// Single client for the process. Node's module cache makes this a singleton;
// the globalThis guard additionally survives `node --watch` reloads in dev,
// which would otherwise leak a connection pool per restart.
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__hcamPrisma ??
  new PrismaClient({
    log: isDev ? ['warn', 'error'] : ['error'],
  });

if (isDev || isTest) {
  globalForPrisma.__hcamPrisma = prisma;
}

// Postgres error codes surfaced through Prisma that the domain layer cares about.
export const PG = {
  UNIQUE_VIOLATION: 'P2002', // Prisma code
  EXCLUSION_VIOLATION: '23P01', // raw SQLSTATE, seen via P2010/meta
  RECORD_NOT_FOUND: 'P2025',
};

/**
 * True when an error came from either guard that protects a slot:
 * the partial unique index or the tsrange EXCLUDE constraint.
 * Both mean the same thing to the caller - somebody else took this slot.
 */
export function isSlotConflict(error) {
  if (!error) return false;
  if (error.code === PG.UNIQUE_VIOLATION) {
    const target = error.meta?.target;
    const asText = Array.isArray(target) ? target.join(',') : String(target ?? '');
    return asText.includes('active_slot') || asText.includes('doctorId');
  }
  // EXCLUDE constraint violations arrive as raw database errors.
  const message = `${error.message ?? ''}`;
  return (
    message.includes('appointments_no_overlap') ||
    message.includes('23P01') ||
    error.meta?.code === '23P01'
  );
}

export async function disconnectPrisma() {
  await prisma.$disconnect();
}
