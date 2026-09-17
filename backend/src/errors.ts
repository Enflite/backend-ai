export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (code = 'UNAUTHORIZED', message = 'Unauthorized', details?: unknown) =>
    new AppError(401, code, message, details),
  forbidden: (code = 'FORBIDDEN', message = 'Forbidden', details?: unknown) =>
    new AppError(403, code, message, details),
  notFound: (code = 'NOT_FOUND', message = 'Not found', details?: unknown) =>
    new AppError(404, code, message, details),
  badRequest: (code = 'BAD_REQUEST', message = 'Bad request', details?: unknown) =>
    new AppError(400, code, message, details),
  conflict: (code = 'CONFLICT', message = 'Conflict', details?: unknown) =>
    new AppError(409, code, message, details),
  tooMany: (code = 'RATE_LIMITED', message = 'Too many requests', details?: unknown) =>
    new AppError(429, code, message, details),
  internal: (message = 'Internal server error', details?: unknown, code = 'INTERNAL') =>
    new AppError(500, code, message, details),
};
