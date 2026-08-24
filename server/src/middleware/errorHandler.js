import { ZodError } from 'zod';
import { AppError, SlotUnavailableError } from '../lib/errors.js';
import { isSlotConflict } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

/** 404 for unmatched routes - registered after all other routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.originalUrl}` },
  });
}

/**
 * Terminal error handler. Translates every known failure shape into the same
 * envelope: { error: { code, message, details? } }.
 */
// eslint-disable-next-line no-unused-vars -- Express requires the 4-arg signature
export function errorHandler(err, req, res, _next) {
  // Zod validation failures -> 400 with per-field details.
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
  }

  // A database-level slot guard fired. Surface it as a clean 409 rather than
  // leaking a constraint name to the client.
  if (isSlotConflict(err)) {
    const conflict = new SlotUnavailableError();
    logger.warn('slot conflict rejected by database guard', {
      path: req.originalUrl,
      dbCode: err.code,
    });
    return res.status(conflict.status).json({
      error: { code: conflict.code, message: conflict.message },
    });
  }

  if (err instanceof AppError) {
    const level = err.status >= 500 ? 'error' : 'warn';
    logger[level](err.message, { code: err.code, path: req.originalUrl });
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  // Anything unrecognised is a bug. Log it fully, tell the client nothing.
  logger.error('unhandled error', {
    message: err?.message,
    stack: err?.stack,
    path: req.originalUrl,
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our end.',
      ...(isProd ? {} : { debug: err?.message }),
    },
  });
}

/** Wraps an async route handler so rejected promises reach errorHandler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
