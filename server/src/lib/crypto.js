import crypto from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM. OAuth refresh tokens are long-lived credentials to a user's
// calendar, so they are never stored in plaintext.
const KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  // iv:tag:ciphertext
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, data] = String(payload).split(':');
  if (!iv || !tag || !data) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // key rotated or value tampered with
  }
}
