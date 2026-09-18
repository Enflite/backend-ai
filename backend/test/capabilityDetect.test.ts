import { describe, expect, it } from 'vitest';
import { detectCapability } from '../src/chat/capabilityDetect.js';

describe('detectCapability', () => {
  describe('syteline', () => {
    it('routes late-order investigations when SyteLine tools are offered', () => {
      expect(detectCapability('Why is customer order SO-77821 late?', { sytelineToolsOffered: true })).toBe('syteline');
    });
    it('routes stock questions by item number', () => {
      expect(detectCapability('How many of ITEM-33001 are on hand in Fort Worth?', { sytelineToolsOffered: true })).toBe('syteline');
    });
    it('routes fulfillment language', () => {
      expect(detectCapability('Has order SO-99012 shipped yet?', { sytelineToolsOffered: true })).toBe('syteline');
      expect(detectCapability('show me open purchase orders for ITEM-9', { sytelineToolsOffered: true })).toBe('syteline');
      expect(detectCapability('explode the BOM for WIDGET-1', { sytelineToolsOffered: true })).toBe('syteline');
    });
    it('stays on chat when SyteLine tools are NOT offered, even for ERP words', () => {
      // Detection can never grant tool access the caller lacks.
      expect(detectCapability('Why is customer order SO-77821 late?', { sytelineToolsOffered: false })).toBe('chat');
    });
    it('does not route casual "ordered lunch late" chatter to syteline', () => {
      expect(detectCapability('I ordered lunch late today', { sytelineToolsOffered: true })).toBe('chat');
    });
  });

  describe('coding', () => {
    it('routes code fences', () => {
      expect(detectCapability('What does this do?\n```python\nprint(1)\n```', { sytelineToolsOffered: true })).toBe('coding');
    });
    it('routes repo paths', () => {
      expect(detectCapability('Where is the retry logic in backend/src/chat/routes.ts?', { sytelineToolsOffered: true })).toBe('coding');
    });
    it('routes code verbs aimed at code nouns', () => {
      expect(detectCapability('Write a function that parses CSV rows', { sytelineToolsOffered: true })).toBe('coding');
      expect(detectCapability('Debug this stack trace for me', { sytelineToolsOffered: true })).toBe('coding');
      expect(detectCapability('Give me the change as a unified diff', { sytelineToolsOffered: true })).toBe('coding');
    });
    it('prefers coding over syteline when both signals appear', () => {
      // Explicit code intent ("write a function") beats an ERP keyword.
      expect(
        detectCapability('Write a Python function that checks stock for ITEM-123', { sytelineToolsOffered: true })
      ).toBe('coding');
    });
    it('does not treat "fix the order problem" as coding', () => {
      expect(detectCapability('Can you fix the order problem for SO-77821?', { sytelineToolsOffered: true })).toBe('syteline');
    });
  });

  describe('chat default', () => {
    it('routes general questions to chat', () => {
      expect(detectCapability('What is our refund policy?', { sytelineToolsOffered: true })).toBe('chat');
      expect(detectCapability('Summarize this document for me', { sytelineToolsOffered: false })).toBe('chat');
      expect(detectCapability('Hello!', { sytelineToolsOffered: true })).toBe('chat');
    });
  });
});
