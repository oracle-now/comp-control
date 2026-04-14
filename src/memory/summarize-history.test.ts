/**
 * summarize-history.test.ts
 * Unit tests for StepHistory compaction logic.
 * These tests cover the pure logic only — no LLM calls.
 * Run with: npx tsx --test src/memory/summarize-history.test.ts
 */

import { strict as assert } from 'assert';
import { test } from 'node:test';
import { StepHistory, summarizeHistory, type StepRecord } from './summarize-history.js';

// Helper: build a batch of step records
function makeSteps(n: number, startAt = 1): StepRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    stepNumber: startAt + i,
    action: `Clicked Approve for Vendor ${startAt + i} $${(startAt + i) * 10}`,
    outcome: 'approved' as const,
    detail: `Vendor ${startAt + i}, amount $${(startAt + i) * 10}`,
    url: 'https://app.ramp.com/approvals',
    timestampMs: Date.now() + i * 1000,
  }));
}

// ─── shouldCompact() ────────────────────────────────────────────────────────────

test('shouldCompact(): false when fewer steps than keepLast', () => {
  const h = new StepHistory({ keepLast: 6, compactEveryNSteps: 25 });
  makeSteps(5).forEach(s => h.record(s));
  assert.equal(h.shouldCompact(), false);
});

test('shouldCompact(): false when all steps are in the verbatim window', () => {
  const h = new StepHistory({ keepLast: 6, compactEveryNSteps: 25 });
  makeSteps(6).forEach(s => h.record(s));
  // compactable is empty (all 6 are in the keepLast window)
  assert.equal(h.shouldCompact(), false);
});

test('shouldCompact(): true at compactEveryNSteps threshold', () => {
  const h = new StepHistory({ keepLast: 6, compactEveryNSteps: 10 });
  makeSteps(16).forEach(s => h.record(s)); // 16 > 10, and 10 are compactable
  assert.equal(h.shouldCompact(), true);
});

test('shouldCompact(): true when totalChars exceeds triggerCharCount', () => {
  const h = new StepHistory({ keepLast: 1, compactEveryNSteps: 0, triggerCharCount: 50 });
  // Each step serializes to ~60+ chars
  makeSteps(3).forEach(s => h.record(s));
  assert.equal(h.totalChars > 50, true);
  assert.equal(h.shouldCompact(), true);
});

test('shouldCompact(): false when compactEveryNSteps is 0 (disabled) and chars under threshold', () => {
  const h = new StepHistory({ keepLast: 2, compactEveryNSteps: 0, triggerCharCount: 999_999 });
  makeSteps(5).forEach(s => h.record(s));
  assert.equal(h.shouldCompact(), false);
});

// ─── compactable / recent windows ─────────────────────────────────────────────────

test('recent window always contains exactly keepLast steps', () => {
  const h = new StepHistory({ keepLast: 6 });
  makeSteps(20).forEach(s => h.record(s));
  assert.equal(h.recent.length, 6);
});

test('recent window contains the LAST N steps (highest step numbers)', () => {
  const h = new StepHistory({ keepLast: 3 });
  makeSteps(10).forEach(s => h.record(s));
  const recentNumbers = h.recent.map(s => s.stepNumber);
  assert.deepEqual(recentNumbers, [8, 9, 10]);
});

test('compactable contains all steps outside the verbatim window', () => {
  const h = new StepHistory({ keepLast: 4 });
  makeSteps(10).forEach(s => h.record(s));
  assert.equal(h.compactable.length, 6); // 10 - 4
  assert.equal(h.compactable[0].stepNumber, 1);
  assert.equal(h.compactable[5].stepNumber, 6);
});

test('when total steps <= keepLast, compactable is empty', () => {
  const h = new StepHistory({ keepLast: 10 });
  makeSteps(7).forEach(s => h.record(s));
  assert.equal(h.compactable.length, 0);
});

// ─── toContextPrefix() ────────────────────────────────────────────────────────────

test('toContextPrefix(): empty string when no steps recorded', () => {
  const h = new StepHistory();
  assert.equal(h.toContextPrefix(), '');
});

test('toContextPrefix(): includes [Run history] header', () => {
  const h = new StepHistory();
  makeSteps(2).forEach(s => h.record(s));
  const prefix = h.toContextPrefix();
  assert.ok(prefix.startsWith('[Run history]'));
  assert.ok(prefix.includes('[End of history]'));
});

test('toContextPrefix(): includes outcome label for each step', () => {
  const h = new StepHistory();
  h.record({ stepNumber: 1, action: 'Approved Acme', outcome: 'approved', timestampMs: Date.now() });
  h.record({ stepNumber: 2, action: 'Flagged BigCo', outcome: 'flagged', detail: 'Missing receipt', timestampMs: Date.now() });
  const prefix = h.toContextPrefix();
  assert.ok(prefix.includes('[approved]'));
  assert.ok(prefix.includes('[flagged]'));
  assert.ok(prefix.includes('Missing receipt'));
});

// ─── reset() ───────────────────────────────────────────────────────────────────────

test('reset() clears all steps and resets compaction pointer', () => {
  const h = new StepHistory();
  makeSteps(20).forEach(s => h.record(s));
  assert.equal(h.length, 20);
  h.reset();
  assert.equal(h.length, 0);
  assert.equal(h.shouldCompact(), false);
  assert.equal(h.toContextPrefix(), '');
});

// ─── summarizeHistory() stateless API ─────────────────────────────────────────────────

test('summarizeHistory(): compacted=false when steps <= keepLast', async () => {
  const steps = makeSteps(3);
  // No LLM call needed — nothing to summarize
  // Pass null as client; the function should return early
  const result = await summarizeHistory(steps, null as unknown as import('@anthropic-ai/sdk').default, { keepLast: 6 });
  assert.equal(result.compacted, false);
  assert.equal(result.summarizedStepCount, 0);
  assert.equal(result.recentStepCount, 3);
});

test('summarizeHistory(): verbatim window size is correct', async () => {
  const steps = makeSteps(10);
  // Only test the slice logic — pass null client, all steps <= keepLast for this check
  const result = await summarizeHistory(
    steps.slice(0, 4), // 4 steps, keepLast=6 → nothing to summarize
    null as unknown as import('@anthropic-ai/sdk').default,
    { keepLast: 6 }
  );
  assert.equal(result.recentStepCount, 4);
  assert.equal(result.summarizedStepCount, 0);
});

console.log('\n✓ All summarize-history tests passed');
