/**
 * Domain errors. Every one carries an HTTP status and a stable machine-readable
 * `code` so the frontend can branch on the code instead of parsing prose.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details = null) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, { status: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { status: 404, code: 'NOT_FOUND' });
  }
}

/** Slot already taken, hold expired, doctor went on leave - anything racy. */
export class ConflictError extends AppError {
  constructor(message = 'The requested change conflicts with the current state', details = null) {
    super(message, { status: 409, code: 'CONFLICT', details });
  }
}

export class SlotUnavailableError extends ConflictError {
  constructor(message = 'That slot has just been taken. Please pick another.') {
    super(message);
    this.code = 'SLOT_UNAVAILABLE';
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, { status: 429, code: 'RATE_LIMITED' });
  }
}

/**
 * Raised when an external dependency (LLM, email, Google) fails. Callers decide
 * whether to degrade or propagate - most degrade.
 */
export class ExternalServiceError extends AppError {
  constructor(service, message, { retryable = true } = {}) {
    super(message ?? `${service} is unavailable`, {
      status: 502,
      code: 'EXTERNAL_SERVICE_ERROR',
    });
    this.service = service;
    this.retryable = retryable;
  }
}
