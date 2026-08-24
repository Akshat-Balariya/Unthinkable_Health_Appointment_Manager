import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { ExternalServiceError } from '../errors.js';

const log = logger.child('mail');

let cached = null;

/**
 * Two transports.
 *
 *   console - logs the rendered message instead of sending. This is not just a
 *             test double: it is the default, so the whole system is
 *             demonstrable without SMTP credentials, and no real email can
 *             escape from a development machine seeded with fake addresses.
 *   smtp    - any provider (SendGrid, Brevo, Mailgun, Gmail, Mailtrap).
 *
 * The worker treats both identically; only deliverability differs.
 */
function build() {
  if (env.MAIL_TRANSPORT === 'smtp') {
    if (!env.SMTP_HOST) {
      throw new Error('MAIL_TRANSPORT=smtp but SMTP_HOST is not set');
    }
    log.info('using SMTP transport', { host: env.SMTP_HOST, port: env.SMTP_PORT });
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      // Keep one connection warm across a batch rather than reconnecting per message.
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
    });
  }

  log.info('using console transport - messages are logged, not delivered');
  return {
    async sendMail(message) {
      log.info('EMAIL (not delivered)', {
        to: message.to,
        subject: message.subject,
      });
      // The full body goes to debug so normal logs stay readable.
      log.debug('email body', { text: message.text });
      return { messageId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    },
    async verify() {
      return true;
    },
    close() {},
  };
}

export function mailTransport() {
  if (!cached) cached = build();
  return cached;
}

/**
 * Sends one message. Classifies failures so the worker knows whether retrying
 * is worthwhile: a rejected recipient will be rejected again forever, whereas a
 * connection reset probably will not.
 */
export async function sendMail({ to, subject, html, text, replyTo }) {
  const from = `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_EMAIL}>`;

  try {
    const info = await mailTransport().sendMail({
      from,
      to,
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    return { messageId: info.messageId ?? null };
  } catch (err) {
    // 5xx SMTP codes and invalid recipients are permanent.
    const code = err.responseCode ?? err.code;
    const permanent =
      (typeof code === 'number' && code >= 500 && code < 600) ||
      ['EENVELOPE', 'EMESSAGE'].includes(code);

    throw new ExternalServiceError('email', `${err.message}`.slice(0, 300), {
      retryable: !permanent,
    });
  }
}

/** Used by /health/ready to report whether mail is actually usable. */
export async function verifyTransport() {
  try {
    await mailTransport().verify();
    return { ok: true, transport: env.MAIL_TRANSPORT };
  } catch (e) {
    return { ok: false, transport: env.MAIL_TRANSPORT, error: e.message?.slice(0, 200) };
  }
}
