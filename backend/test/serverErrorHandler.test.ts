import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { serverErrorHandler } from '../src/server.js';
import { AppError, Errors } from '../src/errors.js';
import { AuditPersistenceError } from '../src/audit/audit.js';

function harness() {
  const logError = vi.fn();
  const sent: Array<{ status: number; headers: Record<string, string>; body: unknown }> = [];
  const req = { requestId: 'req-1', log: { error: logError } } as unknown as FastifyRequest;
  const state = { statusCode: 200, headers: {} as Record<string, string>, storedHeaders: {} as Record<string, string> };
  const reply = {
    status(code: number): unknown {
      state.statusCode = code;
      return reply;
    },
    header(name: string, value: string): unknown {
      state.headers[name.toLowerCase()] = value;
      return reply;
    },
    getHeader(name: string): string | undefined {
      return state.storedHeaders[name.toLowerCase()];
    },
    /** Simulate a header a plugin set on the reply before the error threw. */
    presetHeader(name: string, value: string): void {
      state.storedHeaders[name.toLowerCase()] = value;
    },
    send(body: unknown): unknown {
      sent.push({ status: state.statusCode, headers: { ...state.headers }, body });
      return reply;
    },
  };
  return { req, reply: reply as unknown as FastifyReply, sent, logError };
}

function bodyOf(sent: Array<{ status: number; body: unknown }>) {
  return (sent[0]!.body as any).error;
}

describe('serverErrorHandler', () => {
  it('honors AppError status codes and codes', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found'), req, reply);
    expect(sent[0]!.status).toBe(404);
    expect(bodyOf(sent)).toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      message: 'Document not found',
      requestId: 'req-1',
    });
  });

  it('maps the audit fail-closed error to 503', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(new AuditPersistenceError(), req, reply);
    expect(sent[0]!.status).toBe(503);
    expect(bodyOf(sent)).toMatchObject({ code: 'AUDIT_PERSISTENCE_FAILED' });
  });

  it('honors framework 429 from @fastify/rate-limit with the friendly busy body', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 }), req, reply);
    expect(sent[0]!.status).toBe(429);
    expect(sent[0]!.body).toEqual({
      error: 'busy',
      message: 'The AI is at capacity right now — please retry in a few seconds.',
      retryAfterSeconds: 30,
    });
    expect(sent[0]!.headers['retry-after']).toBe('30');
  });

  it('reuses the Retry-After the rate-limit plugin set when building the 429 body', () => {
    const { req, reply, sent } = harness();
    (reply as any).presetHeader('retry-after', '17');
    serverErrorHandler(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 }), req, reply);
    expect(sent[0]!.status).toBe(429);
    expect(sent[0]!.body).toMatchObject({ error: 'busy', retryAfterSeconds: 17 });
    expect(sent[0]!.headers['retry-after']).toBe('17');
  });

  it('maps an AppError 429 (global ceiling) to the same busy body', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(Errors.tooMany('GLOBAL_RATE_LIMITED', 'Server is handling too many requests'), req, reply);
    expect(sent[0]!.status).toBe(429);
    expect(sent[0]!.body).toMatchObject({ error: 'busy', retryAfterSeconds: 30 });
    expect(sent[0]!.headers['retry-after']).toBe('30');
  });

  it('honors framework 413 from multipart', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(Object.assign(new Error('File too large'), { statusCode: 413 }), req, reply);
    expect(sent[0]!.status).toBe(413);
    expect(bodyOf(sent)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('maps Fastify validation errors to 400', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(Object.assign(new Error('body bad'), { validation: [{ keyword: 'x' }] }), req, reply);
    expect(sent[0]!.status).toBe(400);
    expect(bodyOf(sent).code).toBe('VALIDATION_ERROR');
  });

  it('keeps unknown errors a generic 500 without leaking internals', () => {
    const { req, reply, sent, logError } = harness();
    serverErrorHandler(new Error('db connection string postgres://secret@host exploded'), req, reply);
    expect(sent[0]!.status).toBe(500);
    expect(bodyOf(sent)).toMatchObject({ code: 'INTERNAL', message: 'Internal server error' });
    expect(JSON.stringify(sent[0]!.body)).not.toContain('postgres://secret@host');
    expect(logError).toHaveBeenCalled();
  });

  it('does not let a 500-statusCode error leak its message either', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(Object.assign(new Error('something internal'), { statusCode: 500 }), req, reply);
    expect(sent[0]!.status).toBe(500);
    expect(bodyOf(sent).message).toBe('Internal server error');
  });

  it('passes AppError details through', () => {
    const { req, reply, sent } = harness();
    serverErrorHandler(new AppError(409, 'CONFIRMATION_REQUIRED', 'confirm', { from: 'A' }), req, reply);
    expect(sent[0]!.status).toBe(409);
    expect(bodyOf(sent).details).toEqual({ from: 'A' });
  });
});
