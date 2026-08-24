import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { UnauthorizedError } from './errors.js';

/**
 * Two-token scheme.
 *
 *  Access token  - short-lived JWT, stateless, sent on every request.
 *  Refresh token - long-lived opaque random string. Only its SHA-256 hash is
 *                  stored, so a database leak does not hand out sessions.
 *
 * Refresh tokens ROTATE: redeeming one revokes it and issues a new pair. If a
 * token that was already revoked is presented again, that means it leaked and
 * is being replayed - so every session for that user is killed.
 */

const REFRESH_BYTES = 48;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Parses "15m" / "7d" / "3600" into milliseconds. */
function ttlToMs(ttl) {
  const m = /^(\d+)([smhd])?$/.exec(String(ttl).trim());
  if (!m) throw new Error(`Invalid TTL: ${ttl}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL }
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Access token has expired');
    }
    throw new UnauthorizedError('Invalid access token');
  }
}

/** Creates and persists a refresh token. Returns the raw value (shown once). */
export async function issueRefreshToken(userId, tx = prisma) {
  const raw = crypto.randomBytes(REFRESH_BYTES).toString('base64url');
  await tx.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL)),
    },
  });
  return raw;
}

export async function issueTokenPair(user, tx = prisma) {
  const refreshToken = await issueRefreshToken(user.id, tx);
  return {
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: Math.floor(ttlToMs(env.JWT_ACCESS_TTL) / 1000),
  };
}

/**
 * Redeems a refresh token, rotating it. Throws UnauthorizedError on anything
 * suspicious, revoking the whole family when replay is detected.
 */
export async function rotateRefreshToken(rawToken) {
  const tokenHash = hashToken(rawToken);

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing) throw new UnauthorizedError('Invalid refresh token');

  // Replay of an already-redeemed token means it leaked - kill every session.
  //
  // This deliberately runs OUTSIDE a transaction. Revoking inside a transaction
  // that then throws would roll the revocation straight back, leaving the
  // stolen family alive: the exact failure this check exists to prevent.
  if (existing.revokedAt) {
    await revokeAllForUser(existing.userId);
    throw new UnauthorizedError('Refresh token has already been used. Please sign in again.');
  }

  if (existing.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token has expired');
  }
  if (!existing.user.isActive) {
    throw new UnauthorizedError('This account has been deactivated');
  }

  return prisma.$transaction(async (tx) => {
    // Claim the token atomically. If two requests race with the same valid
    // token, the `revokedAt: null` guard lets exactly one through; the loser
    // is treated as a replay on its next attempt.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new UnauthorizedError('Refresh token has already been used. Please sign in again.');
    }

    const pair = await issueTokenPair(existing.user, tx);
    return { pair, user: existing.user };
  });
}

export async function revokeRefreshToken(rawToken) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllForUser(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
