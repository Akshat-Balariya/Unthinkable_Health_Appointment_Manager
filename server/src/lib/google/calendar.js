import { google } from 'googleapis';
import { prisma } from '../prisma.js';
import { env } from '../../config/env.js';
import { encrypt, decrypt } from '../crypto.js';
import { logger } from '../logger.js';
import { ExternalServiceError } from '../errors.js';

const log = logger.child('gcal');

export const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
export const calendarEnabled = () =>
  env.GOOGLE_CALENDAR_ENABLED && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

function oauthClient() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
}

/** `state` carries the user id so the callback knows who consented. */
export function authUrl(userId) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline', // required to receive a refresh token
    prompt: 'consent', // force refresh token even on re-consent
    scope: SCOPES,
    state: userId,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code, userId) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  // Google omits refresh_token on re-consent unless prompt=consent; keep the
  // stored one rather than losing offline access.
  const existing = await prisma.calendarAccount.findUnique({ where: { userId } });
  const refresh = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : (existing?.refreshToken ?? null);

  return prisma.calendarAccount.upsert({
    where: { userId },
    update: {
      accessToken: encrypt(tokens.access_token),
      refreshToken: refresh,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope,
      revokedAt: null,
      lastError: null,
    },
    create: {
      userId,
      accessToken: encrypt(tokens.access_token),
      refreshToken: refresh,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope,
    },
  });
}

/**
 * Authorised client for a user. Returns null when they have not connected,
 * which every caller treats as "skip calendar", never as an error.
 */
async function clientFor(userId) {
  const account = await prisma.calendarAccount.findUnique({ where: { userId } });
  if (!account || account.revokedAt) return null;

  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt(account.accessToken),
    refresh_token: decrypt(account.refreshToken),
    expiry_date: account.expiryDate?.getTime() ?? null,
  });

  // Persist tokens Google silently refreshes for us.
  client.on('tokens', async (t) => {
    try {
      await prisma.calendarAccount.update({
        where: { userId },
        data: {
          ...(t.access_token ? { accessToken: encrypt(t.access_token) } : {}),
          ...(t.refresh_token ? { refreshToken: encrypt(t.refresh_token) } : {}),
          ...(t.expiry_date ? { expiryDate: new Date(t.expiry_date) } : {}),
        },
      });
    } catch (e) {
      log.warn('failed to persist refreshed token', { userId, error: e.message });
    }
  });

  return { client, account };
}

function wrap(err) {
  const status = err?.response?.status ?? err?.code;
  const retryable = status === 429 || (status >= 500 && status < 600);
  return new ExternalServiceError('google-calendar', `${status ?? ''} ${err.message}`.trim().slice(0, 300), {
    retryable,
  });
}

function eventBody({ appointment, doctorName, patientName, forDoctor }) {
  return {
    summary: forDoctor
      ? `Consultation - ${patientName}`
      : `Appointment with ${doctorName}`,
    description: forDoctor
      ? `Patient: ${patientName}\nBooked via the clinic portal.`
      : `Doctor: ${doctorName}\nBooked via the clinic portal.`,
    start: { dateTime: appointment.slotStart.toISOString(), timeZone: 'UTC' },
    end: { dateTime: appointment.slotEnd.toISOString(), timeZone: 'UTC' },
    reminders: { useDefault: true },
  };
}

export async function createEvent(userId, params) {
  const ctx = await clientFor(userId);
  if (!ctx) return null;
  try {
    const cal = google.calendar({ version: 'v3', auth: ctx.client });
    const res = await cal.events.insert({
      calendarId: ctx.account.calendarId,
      requestBody: eventBody(params),
    });
    return res.data.id;
  } catch (e) {
    throw wrap(e);
  }
}

export async function updateEvent(userId, eventId, params) {
  const ctx = await clientFor(userId);
  if (!ctx) return null;
  try {
    const cal = google.calendar({ version: 'v3', auth: ctx.client });
    const res = await cal.events.update({
      calendarId: ctx.account.calendarId,
      eventId,
      requestBody: eventBody(params),
    });
    return res.data.id;
  } catch (e) {
    throw wrap(e);
  }
}

export async function deleteEvent(userId, eventId) {
  const ctx = await clientFor(userId);
  if (!ctx) return false;
  try {
    const cal = google.calendar({ version: 'v3', auth: ctx.client });
    await cal.events.delete({ calendarId: ctx.account.calendarId, eventId });
    return true;
  } catch (e) {
    // Already gone is success, not failure.
    const status = e?.response?.status ?? e?.code;
    if (status === 404 || status === 410) return true;
    throw wrap(e);
  }
}

export async function disconnect(userId) {
  const account = await prisma.calendarAccount.findUnique({ where: { userId } });
  if (!account) return false;
  try {
    const token = decrypt(account.refreshToken) ?? decrypt(account.accessToken);
    if (token) await oauthClient().revokeToken(token);
  } catch (e) {
    log.warn('token revoke failed, deleting locally anyway', { userId, error: e.message });
  }
  await prisma.calendarAccount.delete({ where: { userId } });
  return true;
}
