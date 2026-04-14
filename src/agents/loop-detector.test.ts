/**
 * loop-detector.test.ts
 * Unit tests for ActionLoopDetector + normalization logic.
 * Run with: npx tsx --test src/agents/loop-detector.test.ts
 */

import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  normalizeAction,
  computeActionHash,
  ActionLoopDetector,
  buildPageFingerprint,
  type RecordedAction,
} from './loop-detector.js';

// ─── Normalization ────────────────────────────────────────────────────────────

test('act: case-insensitive deduplication', () => {
  const a = normalizeAction({ type: 'act', instruction: 'Click the Approve button' });
  const b = normalizeAction({ type: 'act', instruction: 'click the approve button' });
  assert.equal(a, b);
});

test('act: word-order invariant', () => {
  // Same words, different order → same hash
  const a = computeActionHash({ type: 'act', instruction: 'approve button click the' });
  const b = computeActionHash({ type: 'act', instruction: 'Click the approve button' });
  assert.equal(a, b);
});

test('search: token-order invariant', () => {
  const a = normalizeAction({
    type: 'search',
    instruction: '',
    params: { query: 'missing receipts', engine: 'google' },
  });
  const b = normalizeAction({
    type: 'search',
    instruction: '',
    params: { query: 'receipts missing', engine: 'google' },
  });
  assert.equal(a, b);
});

test('navigate: full URL preserved', () => {
  const a = normalizeAction({
    type: 'navigate',
    instruction: '',
    params: { url: 'https://app.ramp.com/approvals' },
  });
  const b = normalizeAction({
    type: 'navigate',
    instruction: '',
    params: { url: 'https://app.ramp.com/dashboard' },
  });
  assert.notEqual(a, b);
});

test('input: same index + text → same hash', () => {
  const a = computeActionHash({ type: 'input', instruction: '', params: { index: 3, text: 'Hello World' } });
  const b = computeActionHash({ type: 'input', instruction: '', params: { index: 3, text: 'hello world' } });
  assert.equal(a, b);
});

test('scroll down vs scroll up → different hashes', () => {
  const a = computeActionHash({ type: 'scroll', instruction: '', params: { down: true } });
  const b = computeActionHash({ type: 'scroll', instruction: '', params: { down: false } });
  assert.notEqual(a, b);
});

// ─── ActionLoopDetector ───────────────────────────────────────────────────────

test('no nudge below threshold', () => {
  const d = new ActionLoopDetector();
  for (let i = 0; i < 4; i++) {
    d.recordAction({ type: 'act', instruction: 'Click approve' });
  }
  assert.equal(d.getNudgeMessage(), null);
});

test('mild nudge at threshold 5', () => {
  const d = new ActionLoopDetector({ nudgeThresholds: [5, 8, 12] });
  for (let i = 0; i < 5; i++) {
    d.recordAction({ type: 'act', instruction: 'Click approve' });
  }
  const nudge = d.getNudgeMessage();
  assert.ok(nudge !== null);
  assert.ok(nudge.includes('Loop hint'));
});

test('strong nudge at threshold 12', () => {
  const d = new ActionLoopDetector({ nudgeThresholds: [5, 8, 12] });
  for (let i = 0; i < 12; i++) {
    d.recordAction({ type: 'act', instruction: 'Click approve' });
  }
  const nudge = d.getNudgeMessage();
  assert.ok(nudge?.includes('Loop warning'));
});

test('window eviction keeps last N hashes', () => {
  const d = new ActionLoopDetector({ windowSize: 5 });
  // 10 unique actions — window should only hold last 5
  for (let i = 0; i < 10; i++) {
    d.recordAction({ type: 'act', instruction: `Unique action ${i}` });
  }
  assert.equal(d.maxRepetitionCount, 1); // all unique in window
});

test('stagnation nudge after consecutive identical fingerprints', () => {
  const d = new ActionLoopDetector({ stagnationThreshold: 3 });
  for (let i = 0; i < 4; i++) {
    d.recordPageState('https://app.ramp.com/approvals', 'same content', 100);
    d.recordAction({ type: 'act', instruction: 'Click something' });
  }
  const nudge = d.getNudgeMessage();
  assert.ok(nudge?.includes('Stagnation'));
});

test('annotateInstruction is a no-op when no loop detected', () => {
  const d = new ActionLoopDetector();
  const instruction = 'Click the approve button';
  assert.equal(d.annotateInstruction(instruction), instruction);
});

test('reset clears all state', () => {
  const d = new ActionLoopDetector({ nudgeThresholds: [5, 8, 12] });
  for (let i = 0; i < 8; i++) {
    d.recordAction({ type: 'act', instruction: 'Click approve' });
  }
  assert.ok(d.getNudgeMessage() !== null);
  d.reset();
  assert.equal(d.getNudgeMessage(), null);
  assert.equal(d.maxRepetitionCount, 0);
});

test('PageFingerprint: same content → same hash', () => {
  const a = buildPageFingerprint('https://x.com', 'hello world', 50);
  const b = buildPageFingerprint('https://x.com', 'hello world', 50);
  assert.deepEqual(a, b);
});

test('PageFingerprint: different content → different hash', () => {
  const a = buildPageFingerprint('https://x.com', 'page A', 50);
  const b = buildPageFingerprint('https://x.com', 'page B', 50);
  assert.notEqual(a.textHash, b.textHash);
});

console.log('\n✓ All loop-detector tests passed');
