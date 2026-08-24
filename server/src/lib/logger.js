import { isProd } from '../config/env.js';

/**
 * Deliberately tiny. Structured JSON in production so a hosting provider can
 * index it; readable single lines in development.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug')] ?? 20;

function emit(level, message, meta) {
  if (LEVELS[level] < threshold) return;

  if (isProd) {
    const line = { ts: new Date().toISOString(), level, message, ...(meta ?? {}) };
    console[level === 'debug' ? 'log' : level](JSON.stringify(line));
    return;
  }

  const time = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console[level === 'debug' ? 'log' : level](`${time} ${tag} ${message}${extra}`);
}

export const logger = {
  debug: (m, meta) => emit('debug', m, meta),
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
  /** Namespaced child logger: logger.child('worker').info(...) */
  child: (scope) => ({
    debug: (m, meta) => emit('debug', `[${scope}] ${m}`, meta),
    info: (m, meta) => emit('info', `[${scope}] ${m}`, meta),
    warn: (m, meta) => emit('warn', `[${scope}] ${m}`, meta),
    error: (m, meta) => emit('error', `[${scope}] ${m}`, meta),
  }),
};
