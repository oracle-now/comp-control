/**
 * memory/summarize-history.ts
 *
 * Port of browser-use's MessageCompactionSettings pattern.
 * Source: https://github.com/browser-use/browser-use/blob/main/browser_use/agent/views.py
 *
 * Problem:
 *   A long approval-queue run (50-200 items) accumulates step history.
 *   Sending the full history on every act() call wastes tokens and can
 *   exceed context limits. But we can't just discard history — the agent
 *   needs to know what it's already done.
 *
 * Solution (faithful to browser-use's design):
 *   - Keep a rolling log of step records (StepRecord[]).
 *   - When total char count of the log exceeds `triggerCharCount`,
 *     compact everything OLDER than the last `keepLast` steps into a
 *     single paragraph summary via a cheap LLM call.
 *   - Steps within the keepLast window are kept verbatim — the agent
 *     retains full short-term operational memory.
 *   - The resulting CompactedHistory can be injected as a context prefix
 *     into the next act() instruction.
 *
 * browser-use defaults preserved:
 *   compactEveryNSteps: 25  (compact every 25 steps regardless of char count)
 *   keepLast:           6   (always keep the 6 most recent steps verbatim)
 *   maxSummaryChars:    6000
 *   triggerCharCount:   40000 (~10k tokens)
 */

import Anthropic from '@anthropic-ai/sdk';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type StepOutcome = 'approved' | 'flagged' | 'skipped' | 'error' | 'navigate' | 'other';

export interface StepRecord {
  stepNumber: number;
  action: string;       // Natural language description of what was done
  outcome: StepOutcome;
  detail?: string;      // e.g. vendor name, amount, flag reason, error message
  url?: string;         // Page URL at time of action
  timestampMs: number;
}

export interface CompactedHistory {
  /** LLM-generated paragraph summarizing steps older than the keepLast window */
  summary: string;
  /** Verbatim step records kept in the recent window */
  recentSteps: StepRecord[];
  /** Total steps summarized (for logging/audit) */
  summarizedStepCount: number;
  /** Total steps in the verbatim window */
  recentStepCount: number;
  /** Whether compaction was triggered this cycle */
  compacted: boolean;
}

export interface CompactionSettings {
  /**
   * Compact when total char count of step records exceeds this threshold.
   * Default: 40000 (~10k tokens). browser-use default preserved.
   */
  triggerCharCount?: number;
  /**
   * Also compact every N steps regardless of char count.
   * Default: 25. Set to 0 to disable step-count-based trigger.
   */
  compactEveryNSteps?: number;
  /**
   * Number of most-recent steps to keep verbatim (never summarized).
   * Default: 6. browser-use default preserved.
   */
  keepLast?: number;
  /**
   * Max characters in the generated summary paragraph.
   * Default: 6000. Truncated if the LLM overshoots.
   */
  maxSummaryChars?: number;
  /**
   * Claude model used for summarization.
   * Default: claude-haiku-3-5 (cheapest, fast, good at structured summarization).
   * Intentionally NOT claude-sonnet — this is a cost-sensitive side-call.
   */
  compactionModel?: string;
}

// ─── StepHistory ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  triggerCharCount: 40_000,
  compactEveryNSteps: 25,
  keepLast: 6,
  maxSummaryChars: 6_000,
  compactionModel: 'claude-haiku-3-5',
} as const;

/**
 * Stateful step log for a single agent run.
 *
 * Usage:
 *   const history = new StepHistory();
 *   history.record({ stepNumber: 1, action: '...', outcome: 'approved', ... });
 *
 *   // In the approval loop, after every act():
 *   if (history.shouldCompact()) {
 *     const compacted = await history.compact(anthropicClient);
 *     // inject compacted.toContextPrefix() into next act()
 *   }
 */
export class StepHistory {
  private steps: StepRecord[] = [];
  private lastCompactedAt = 0; // stepNumber of last compaction
  private readonly settings: Required<CompactionSettings>;

  constructor(settings: CompactionSettings = {}) {
    this.settings = {
      triggerCharCount: settings.triggerCharCount ?? DEFAULTS.triggerCharCount,
      compactEveryNSteps: settings.compactEveryNSteps ?? DEFAULTS.compactEveryNSteps,
      keepLast: settings.keepLast ?? DEFAULTS.keepLast,
      maxSummaryChars: settings.maxSummaryChars ?? DEFAULTS.maxSummaryChars,
      compactionModel: settings.compactionModel ?? DEFAULTS.compactionModel,
    };
  }

  /** Record a completed step. Call after every act(). */
  record(step: StepRecord): void {
    this.steps.push(step);
  }

  /** Total number of recorded steps. */
  get length(): number {
    return this.steps.length;
  }

  /** All recorded steps (read-only snapshot). */
  get all(): readonly StepRecord[] {
    return this.steps;
  }

  /**
   * Steps older than the keepLast window — candidates for summarization.
   * Returns empty array if total steps <= keepLast.
   */
  get compactable(): StepRecord[] {
    const cutoff = Math.max(0, this.steps.length - this.settings.keepLast);
    return this.steps.slice(0, cutoff);
  }

  /** The verbatim recent window — always kept, never summarized. */
  get recent(): StepRecord[] {
    const cutoff = Math.max(0, this.steps.length - this.settings.keepLast);
    return this.steps.slice(cutoff);
  }

  /** Total char count of all step records (serialized). Used for threshold check. */
  get totalChars(): number {
    return this.steps.reduce((sum, s) => sum + serializeStep(s).length, 0);
  }

  /**
   * True if compaction should be triggered.
   * Two triggers (either fires compaction):
   *   1. totalChars >= triggerCharCount
   *   2. steps since last compaction >= compactEveryNSteps
   */
  shouldCompact(): boolean {
    if (this.compactable.length === 0) return false;

    const stepsSinceCompaction =
      this.steps.length - this.lastCompactedAt;

    return (
      this.totalChars >= this.settings.triggerCharCount ||
      (this.settings.compactEveryNSteps > 0 &&
        stepsSinceCompaction >= this.settings.compactEveryNSteps)
    );
  }

  /**
   * Compact older steps into a summary paragraph.
   * After compaction, the internal step log is replaced with:
   *   [synthetic summary step] + [keepLast recent steps verbatim]
   *
   * @param client  Anthropic SDK instance (passed in to avoid re-instantiation)
   * @returns       CompactedHistory with summary + verbatim recent window
   */
  async compact(client: Anthropic): Promise<CompactedHistory> {
    const toSummarize = this.compactable;
    const verbatim = this.recent;

    if (toSummarize.length === 0) {
      return {
        summary: '',
        recentSteps: verbatim,
        summarizedStepCount: 0,
        recentStepCount: verbatim.length,
        compacted: false,
      };
    }

    const summary = await summarizeSteps(toSummarize, client, {
      maxSummaryChars: this.settings.maxSummaryChars,
      model: this.settings.compactionModel,
    });

    // Replace internal log: synthetic summary record + verbatim window
    const summaryRecord: StepRecord = {
      stepNumber: toSummarize[0].stepNumber,
      action: `[COMPACTED SUMMARY: steps ${toSummarize[0].stepNumber}–${toSummarize[toSummarize.length - 1].stepNumber}] ${summary}`,
      outcome: 'other',
      timestampMs: Date.now(),
    };

    this.steps = [summaryRecord, ...verbatim];
    this.lastCompactedAt = this.steps.length;

    return {
      summary,
      recentSteps: verbatim,
      summarizedStepCount: toSummarize.length,
      recentStepCount: verbatim.length,
      compacted: true,
    };
  }

  /**
   * Render the full history as a context prefix string.
   * If compacted, includes the summary paragraph followed by the verbatim window.
   * Inject this into the next act() instruction to give the agent memory.
   */
  toContextPrefix(): string {
    if (this.steps.length === 0) return '';

    const lines: string[] = ['[Run history]'];
    for (const step of this.steps) {
      lines.push(serializeStep(step));
    }
    lines.push('[End of history]');
    return lines.join('\n');
  }

  reset(): void {
    this.steps = [];
    this.lastCompactedAt = 0;
  }

  /** Stats for RunSummary */
  getStats() {
    return {
      totalSteps: this.steps.length,
      totalChars: this.totalChars,
      recentWindowSize: this.settings.keepLast,
      compactEveryNSteps: this.settings.compactEveryNSteps,
      triggerCharCount: this.settings.triggerCharCount,
    };
  }
}

// ─── summarizeHistory() — stateless entry point ──────────────────────────────────

/**
 * Stateless utility: given a list of StepRecords, returns a compacted
 * CompactedHistory without mutating anything. Use this when you want
 * to summarize a snapshot rather than manage running state.
 *
 * Equivalent to browser-use's construct_judge_messages() approach
 * for building context from traces.
 */
export async function summarizeHistory(
  steps: StepRecord[],
  client: Anthropic,
  settings: CompactionSettings = {}
): Promise<CompactedHistory> {
  const keepLast = settings.keepLast ?? DEFAULTS.keepLast;
  const maxSummaryChars = settings.maxSummaryChars ?? DEFAULTS.maxSummaryChars;
  const model = settings.compactionModel ?? DEFAULTS.compactionModel;

  const cutoff = Math.max(0, steps.length - keepLast);
  const toSummarize = steps.slice(0, cutoff);
  const verbatim = steps.slice(cutoff);

  if (toSummarize.length === 0) {
    return {
      summary: '',
      recentSteps: verbatim,
      summarizedStepCount: 0,
      recentStepCount: verbatim.length,
      compacted: false,
    };
  }

  const summary = await summarizeSteps(toSummarize, client, { maxSummaryChars, model });

  return {
    summary,
    recentSteps: verbatim,
    summarizedStepCount: toSummarize.length,
    recentStepCount: verbatim.length,
    compacted: true,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────────

function serializeStep(step: StepRecord): string {
  const parts = [
    `Step ${step.stepNumber} [${step.outcome}]: ${step.action}`,
  ];
  if (step.detail) parts.push(`  ↳ ${step.detail}`);
  if (step.url) parts.push(`  ↳ url: ${step.url}`);
  return parts.join('\n');
}

async function summarizeSteps(
  steps: StepRecord[],
  client: Anthropic,
  opts: { maxSummaryChars: number; model: string }
): Promise<string> {
  const stepsText = steps.map(serializeStep).join('\n');

  const message = await client.messages.create({
    model: opts.model,
    max_tokens: Math.ceil(opts.maxSummaryChars / 3.5), // ~3.5 chars/token
    messages: [
      {
        role: 'user',
        content: `You are summarizing the completed steps of an AP expense review agent run.

Below are the step records to summarize:

${stepsText}

Write a single concise paragraph (max ${opts.maxSummaryChars} characters) summarizing:
- How many items were reviewed, approved, and flagged
- Any notable patterns (repeated vendors, high-value flags, missing receipts cluster)
- Any errors or navigation events
- The overall state when this window ended

Be factual and specific. No filler phrases. Output only the summary paragraph.`,
      },
    ],
  });

  const raw =
    message.content[0]?.type === 'text' ? message.content[0].text : '';

  // Enforce char budget — hard truncate if the model overshoots
  return raw.slice(0, opts.maxSummaryChars);
}
