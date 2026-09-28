import { describe, expect, it } from 'vitest';
import { isSmallTalk } from '../src/chat/smalltalk.js';

describe('isSmallTalk', () => {
  describe('greetings', () => {
    it.each(['Hello', 'hello', 'HELLO', 'hi', 'Hi!', 'hey', 'hey there!', 'yo', 'good morning', 'Good Morning!', 'good afternoon', 'good evening'])(
      'treats %j as small talk',
      (content) => {
        expect(isSmallTalk(content)).toBe(true);
      }
    );
  });

  describe('thanks', () => {
    it.each(['thanks', 'Thanks!', 'thank you', 'Thank you so much', 'thanks for your help', 'thx'])(
      'treats %j as small talk',
      (content) => {
        expect(isSmallTalk(content)).toBe(true);
      }
    );
  });

  describe('farewells', () => {
    it.each(['bye', 'Bye!', 'goodbye', 'see you later', 'see you soon', 'good night', 'take care'])(
      'treats %j as small talk',
      (content) => {
        expect(isSmallTalk(content)).toBe(true);
      }
    );
  });

  describe('pleasantry questions', () => {
    it.each(['how are you?', 'how are you', "how's it going?", "what's up?", 'hey, how are you?'])(
      'treats %j as small talk',
      (content) => {
        expect(isSmallTalk(content)).toBe(true);
      }
    );
  });

  describe('genuine questions still route normally', () => {
    it.each([
      // SyteLine ERP intent hiding behind a greeting.
      'hello, what is the status of order SO-123?',
      'hi, can you check the BOM for item ABC-123?',
      'hey, is SO-77821 past due?',
      'good morning, what is on hand for item XYZ?',
      // Coding intent.
      'hello, can you fix this bug in auth.ts?',
      'hi, write a function that parses CSV',
      // A real (if vague) request, not chit-chat.
      'hello, can you help me?',
      'hi, I need help with something',
    ])('does NOT treat %j as small talk', (content) => {
      expect(isSmallTalk(content)).toBe(false);
    });
  });

  describe('conservative exclusions', () => {
    it.each([
      // Bare acknowledgments may mean "proceed" mid-conversation — only the
      // model with history can tell, so they route normally.
      'ok',
      'okay',
      'yes',
      'yeah',
      'sure',
      'go ahead',
      // A bare filename is plausibly a repo question, not a greeting.
      'hello.ts',
      // Empty / whitespace.
      '',
      '   ',
      // Too long to be pure chit-chat.
      'hello '.repeat(30),
    ])('does NOT treat %j as small talk', (content) => {
      expect(isSmallTalk(content)).toBe(false);
    });
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(isSmallTalk('  Hi  ')).toBe(true);
    expect(isSmallTalk('HELLO!')).toBe(true);
  });
});
