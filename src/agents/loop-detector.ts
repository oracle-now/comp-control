/**
 * agents/loop-detector.ts
 *
 * TypeScript port of browser-use's ActionLoopDetector + PageFingerprint.
 * Source: https://github.com/browser-use/browser-use/blob/main/browser_use/agent/views.py
 *
 * Design philosophy (preserved from upstream):
 *   - Soft detection only — nudges are context messages injected into the
 *     next act() call. The agent can still repeat if it chooses to.
 *   - Never hard-blocks an action. Financial workflows need human escalation,
 *     not silent agent freezes.
 *   - Normalization over raw hashing — two semantically identical actions
 *     ("approve invoice #1042" vs "Approve Invoice #1042") hash the same.
 */

import { createHash } from 'crypto';

// ─── Action type discriminated union ────────────────────────────────────────

export type ActionType =
  | 'act'
  | 'extract'
  | 'observe'
  | 'navigate'
  | 'scroll'
  | 'search'
  | 'click'
  | 'input'
  | 'other';

export interface RecordedAction {
  type: ActionType;
  /** Raw natural-language instruction or structured params */
  instruction: string;
  /** Optional: structured params for precise normalization */
  params?: Record<string, unknown>;
}

// ─── PageFingerprint ─────────────────────────────────────────────────────────

export interface PageFingerprint {
  url: string;
  elementCount: number;
  /** First 16 chars of SHA-256 of the DOM text representation */
  textHash: string;
}

export function buildPageFingerprint(
  url: string,
  domText: string,
  elementCount: number
): PageFingerprint {
  const textHash = createHash('sha256')
    .update(domText, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return { url, elementCount, textHash };
}

function fingerprintsEqual(a: PageFingerprint, b: PageFingerprint): boolean {
  return a.url === b.url && a.elementCount === b.elementCount && a.textHash === b.textHash;
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize an action to a canonical string for stable hashing.
 *
 * Ported from browser-use's _normalize_action_for_hash() with additions
 * for Stagehand's natural-language act() instruction style.
 */
export function normalizeAction(action: RecordedAction): string {
  const { type, instruction, params = {} } = action;

  switch (type) {
    case 'search': {
      const query = String(params['query'] ?? instruction);
      const engine = String(params['engine'] ?? 'google');
      // Lowercase, dedupe tokens, sort — "missing receipts" == "receipts missing"
      const tokens = [...new Set(
        query.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
      )].sort();
      return `search|${engine}|${tokens.join('|')}`;
    }

    case 'navigate': {
      const url = String(params['url'] ?? instruction);
      return `navigate|${url}`;
    }

    case 'click': {
      const index = params['index'] != null ? String(params['index']) : null;
      if (index) return `click|${index}`;
      // Fall through to act-style normalization
      break;
    }

    case 'input': {
      const index = params['index'] != null ? String(params['index']) : null;
      const text = String(params['text'] ?? '').trim().toLowerCase();
      if (index) return `input|${index}|${text}`;
      break;
    }

    case 'scroll': {
      const direction = params['down'] !== false ? 'down' : 'up';
      const index = params['index'] != null ? String(params['index']) : 'page';
      return `scroll|${direction}|${index}`;
    }

    case 'extract':
    case 'observe': {
      // Normalize by lower-cased, sorted keyword tokens
      const tokens = [...new Set(
        instruction.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
      )].sort();
      return `${type}|${tokens.join('|')}`;
    }

    case 'act': {
      // Natural language — normalize same way: lower, dedupe, sort
      // "Click the Approve button for vendor X" and repeated variants hash similarly
      const tokens = [...new Set(
        instruction.toLowerCase().replace(/[^\w\s$]/g, ' ').split(/\s+/).filter(Boolean)
      )].sort();
      return `act|${tokens.join('|')}`;
    }
  }

  // Default: type + sorted instruction tokens
  const tokens = [...new Set(
    instruction.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
  )].sort();
  return `${type}|${tokens.join('|')}`;
}

export function computeActionHash(action: RecordedAction): string {
  const normalized = normalizeAction(action);
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

// ─── ActionLoopDetector ──────────────────────────────────────────────────────

export interface LoopDetectorOptions {
  windowSize?: number;
  nudgeThresholds?: [number, number, number]; // [mild, moderate, strong]
  stagnationThreshold?: number;
}

export class ActionLoopDetector {
  private readonly windowSize: number;
  private readonly nudgeThresholds: [number, number, number];
  private readonly stagnationThreshold: number;

  private recentHashes: string[] = [];
  private recentFingerprints: PageFingerprint[] = [];

  // Public stats — useful for run summaries / logging
  maxRepetitionCount = 0;
  mostRepeatedHash: string | null = null;
  consecutiveStagnantPages = 0;

  constructor(options: LoopDetectorOptions = {}) {
    this.windowSize = options.windowSize ?? 20;
    this.nudgeThresholds = options.nudgeThresholds ?? [5, 8, 12];
    this.stagnationThreshold = options.stagnationThreshold ?? 5;
  }

  /** Record an action and update repetition stats. Call after every act(). */
  recordAction(action: RecordedAction): void {
    const hash = computeActionHash(action);
    this.recentHashes.push(hash);
    if (this.recentHashes.length > this.windowSize) {
      this.recentHashes = this.recentHashes.slice(-this.windowSize);
    }
    this.updateRepetitionStats();
  }

  /**
   * Record the current page state for stagnation detection.
   * Call after each act() using a cheap DOM snapshot:
   *   const domText = await stagehand.page.evaluate(() => document.body.innerText);
   *   const count = await stagehand.page.evaluate(() => document.querySelectorAll('*').length);
   */
  recordPageState(url: string, domText: string, elementCount: number): void {
    const fp = buildPageFingerprint(url, domText, elementCount);
    const last = this.recentFingerprints.at(-1);
    if (last && fingerprintsEqual(last, fp)) {
      this.consecutiveStagnantPages++;
    } else {
      this.consecutiveStagnantPages = 0;
    }
    this.recentFingerprints.push(fp);
    if (this.recentFingerprints.length > 5) {
      this.recentFingerprints = this.recentFingerprints.slice(-5);
    }
  }

  /**
   * Return an escalating nudge message if a loop is detected, or null.
   * Inject this into the instruction prefix of the next act() call.
   */
  getNudgeMessage(): string | null {
    const messages: string[] = [];
    const [mild, moderate, strong] = this.nudgeThresholds;
    const windowLen = this.recentHashes.length;

    if (this.maxRepetitionCount >= strong) {
      messages.push(
        `[Loop warning] You have repeated a similar action ${this.maxRepetitionCount} times ` +
        `in the last ${windowLen} actions. If you are making progress with each repetition, ` +
        `keep going. Otherwise, a different approach may get you there faster.`
      );
    } else if (this.maxRepetitionCount >= moderate) {
      messages.push(
        `[Loop notice] You have repeated a similar action ${this.maxRepetitionCount} times ` +
        `in the last ${windowLen} actions. Are you still making progress? ` +
        `If so, carry on — otherwise consider a different approach.`
      );
    } else if (this.maxRepetitionCount >= mild) {
      messages.push(
        `[Loop hint] Similar action repeated ${this.maxRepetitionCount} times ` +
        `in the last ${windowLen} steps. If intentional and progressing, carry on.`
      );
    }

    if (this.consecutiveStagnantPages >= this.stagnationThreshold) {
      messages.push(
        `[Stagnation] The page content has not changed across ` +
        `${this.consecutiveStagnantPages} consecutive actions. ` +
        `Your actions may not be having the intended effect — ` +
        `consider trying a different element or approach.`
      );
    }

    return messages.length > 0 ? messages.join('\n\n') : null;
  }

  /** Prepend nudge to instruction if a loop is detected. Pure utility. */
  annotateInstruction(instruction: string): string {
    const nudge = this.getNudgeMessage();
    return nudge ? `${nudge}\n\n${instruction}` : instruction;
  }

  reset(): void {
    this.recentHashes = [];
    this.recentFingerprints = [];
    this.maxRepetitionCount = 0;
    this.mostRepeatedHash = null;
    this.consecutiveStagnantPages = 0;
  }

  /** Snapshot for run summaries */
  getStats() {
    return {
      windowSize: this.windowSize,
      recentActionCount: this.recentHashes.length,
      maxRepetitionCount: this.maxRepetitionCount,
      mostRepeatedHash: this.mostRepeatedHash,
      consecutiveStagnantPages: this.consecutiveStagnantPages,
    };
  }

  private updateRepetitionStats(): void {
    if (this.recentHashes.length === 0) {
      this.maxRepetitionCount = 0;
      this.mostRepeatedHash = null;
      return;
    }
    const counts: Record<string, number> = {};
    for (const h of this.recentHashes) {
      counts[h] = (counts[h] ?? 0) + 1;
    }
    const topHash = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    this.mostRepeatedHash = topHash[0];
    this.maxRepetitionCount = topHash[1];
  }
}
