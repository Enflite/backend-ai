import { describe, expect, it } from 'vitest';
import {
  attachmentActivityEntries,
  deriveStatusText,
  friendlyNoticeText,
  friendlyToolName,
  friendlyToolNames,
  nextAssistantState,
  noticeToActivityEntries,
  sourcesActivityEntry,
} from './activity';

describe('friendlyToolName', () => {
  it('maps known tools to human labels', () => {
    expect(friendlyToolName('syteline.getItem')).toBe('Looking up an item');
    expect(friendlyToolName('repo.readFile')).toBe('Reading a file');
    expect(friendlyToolName('syteline.form_build_deck')).toBe('Building a presentation');
  });

  it('never leaks a raw dotted name for unknown tools', () => {
    const label = friendlyToolName('syteline.someFutureTool');
    expect(label).not.toContain('syteline');
    expect(label).not.toContain('.');
    expect(label).toBe('Some future tool');
  });

  it('dedupes while preserving order', () => {
    expect(friendlyToolNames(['syteline.getItem', 'syteline.getItem', 'repo.search'])).toEqual([
      'Looking up an item',
      'Searching the codebase',
    ]);
  });
});

describe('nextAssistantState', () => {
  it('enters tools state on tool notices', () => {
    expect(nextAssistantState('thinking', 'notice', 'TOOL_PLAN')).toBe('tools');
    expect(nextAssistantState('streaming', 'notice', 'TOOL_CALLS')).toBe('tools');
  });

  it('ignores informational notices', () => {
    expect(nextAssistantState('thinking', 'notice', 'MODEL_VISION_SWITCH')).toBe('thinking');
    expect(nextAssistantState('tools', 'notice', 'MODEL_FAILOVER')).toBe('tools');
  });

  it('streams on tokens and idles on completion', () => {
    expect(nextAssistantState('thinking', 'delta')).toBe('streaming');
    expect(nextAssistantState('tools', 'delta')).toBe('streaming');
    expect(nextAssistantState('streaming', 'done')).toBe('idle');
    expect(nextAssistantState('tools', 'error')).toBe('idle');
  });

  it('keeps state on meta events', () => {
    expect(nextAssistantState('thinking', 'meta')).toBe('thinking');
  });
});

describe('deriveStatusText', () => {
  it('covers the four avatar states', () => {
    expect(deriveStatusText('idle')).toBe('Ready');
    expect(deriveStatusText('thinking')).toBe('Thinking…');
    expect(deriveStatusText('streaming')).toBe('Replying…');
    expect(deriveStatusText('tools')).toBe('Working…');
  });

  it('mentions documents while thinking', () => {
    expect(deriveStatusText('thinking', null, 1)).toBe('Reading your document…');
    expect(deriveStatusText('thinking', null, 3)).toBe('Reading your 3 documents…');
  });

  it('names the friendly tool while busy', () => {
    expect(
      deriveStatusText('tools', { code: 'TOOL_CALLS', message: 'x', tools: ['syteline.getItem'] }),
    ).toBe('looking up an item…');
    expect(
      deriveStatusText('tools', { code: 'TOOL_CALLS', message: 'x', tools: ['syteline.getItem', 'repo.search'] }),
    ).toBe('Running 2 tools…');
  });
});

describe('friendlyNoticeText', () => {
  it('strips raw tool names from plan narration', () => {
    const text = friendlyNoticeText({
      code: 'TOOL_PLAN',
      message: "I'll run repo.readFile (hello.ts).",
      tools: ['repo.readFile'],
    });
    expect(text).not.toContain('repo.readFile');
    expect(text).toBe('Reading a file…');
  });

  it('keeps the tool-call count wording', () => {
    expect(friendlyNoticeText({ code: 'TOOL_CALLS', message: 'Running 2 tool calls…', tools: ['a', 'b'] }))
      .toBe('Running 2 tool calls…');
  });

  it('passes vision/failover messages through (backend uses display names)', () => {
    const message = 'Reading your image with Qwen 2.5 VL — the selected model can’t view images.';
    expect(friendlyNoticeText({ code: 'MODEL_VISION_SWITCH', message })).toBe(message);
  });
});

describe('noticeToActivityEntries', () => {
  it('records one friendly entry per tool round', () => {
    const entries = noticeToActivityEntries(
      { code: 'TOOL_CALLS', message: 'x', tools: ['syteline.getItem', 'syteline.getItemAvailability'] },
      'msg-1',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Ran 2 tools');
    expect(entries[0].detail).toBe('Looking up an item, Checking inventory');
    expect(entries[0].messageId).toBe('msg-1');
    expect(entries[0].title).not.toContain('syteline');
  });

  it('uses the friendly name directly for a single tool', () => {
    const entries = noticeToActivityEntries(
      { code: 'TOOL_CALLS', message: 'x', tools: ['repo.search'] },
      'msg-1',
    );
    expect(entries[0].title).toBe('Searching the codebase');
  });

  it('records vision switches and failovers without raw ids', () => {
    const vision = noticeToActivityEntries({ code: 'MODEL_VISION_SWITCH', message: 'x' });
    expect(vision[0].kind).toBe('vision');
    expect(vision[0].title).toBe('Used the vision model');

    const failover = noticeToActivityEntries({ code: 'MODEL_FAILOVER', message: 'x' });
    expect(failover[0].title).toBe('Continued with a backup model');
  });

  it('skips plans and unknown codes', () => {
    expect(noticeToActivityEntries({ code: 'TOOL_PLAN', message: 'x', tools: ['repo.readFile'] })).toEqual([]);
    expect(noticeToActivityEntries({ code: 'SOMETHING_ELSE', message: 'x' })).toEqual([]);
  });
});

describe('sourcesActivityEntry', () => {
  it('returns null when there are no citations', () => {
    expect(sourcesActivityEntry(0)).toBeNull();
  });

  it('counts sources', () => {
    expect(sourcesActivityEntry(3)?.title).toBe('Used 3 sources');
  });
});

describe('attachmentActivityEntries', () => {
  it('describes a single image warmly', () => {
    const entries = attachmentActivityEntries([{ name: 'screenshot.png', type: 'image/png' }], 'msg-9');
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Looked at your image');
    expect(entries[0].detail).toBe('screenshot.png');
  });

  it('summarizes mixed attachments without leaking paths', () => {
    const entries = attachmentActivityEntries([
      { name: 'screenshot.png', type: 'image/png' },
      { name: 'plan.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    ]);
    expect(entries[0].title).toBe('Reviewed 2 attachments');
  });

  it('returns nothing for no files', () => {
    expect(attachmentActivityEntries([])).toEqual([]);
  });
});
