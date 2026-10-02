/**
 * frontendCopy.test.ts — default-open frontend copy.
 *
 * Jake's standing direction: "no one should ever see" the permissions-denial
 * copy ("No approved model is available for your account"). Serving is
 * default-open, so a healthy backend always yields a model; the frontend
 * must never render a permission-denial empty state. This test reads the
 * shipped App.tsx source and fails if the denial copy (or its error code)
 * ever returns.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_TSX = resolve(__dirname, '../../frontend/src/App.tsx');
// PR #59 moved the chat loading empty state out of App.tsx into ChatView.
const CHAT_VIEW_TSX = resolve(__dirname, '../../frontend/src/views/ChatView.tsx');

describe('frontend default-open copy', () => {
  it('never renders the permissions-denial empty state', () => {
    const source = readFileSync(APP_TSX, 'utf-8');
    expect(source).not.toContain('No approved model');
    expect(source).not.toContain('NO_APPROVED_MODEL');
    expect(source).not.toContain('for your account');
  });

  it('keeps a neutral loading/retry empty state when no model is selected yet', () => {
    const source = readFileSync(CHAT_VIEW_TSX, 'utf-8');
    expect(source).toContain('Still loading the AI');
  });
});
