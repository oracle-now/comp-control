/**
 * agents/accountant.agent.ts
 * The core AP accountant agent — pure Stagehand, zero raw Playwright.
 *
 * All browser interaction goes through Stagehand primitives:
 *   act()     — natural language actions (click, fill, navigate)
 *   extract() — structured data extraction from the current page
 *   observe() — screenshot + identify what's actionable
 *   agent()   — autonomous multi-step execution
 *
 * We intentionally avoid stagehand.page.* calls. The whole value of
 * Stagehand is that the agent adapts to UI changes — mixing in raw
 * Playwright selectors would re-introduce the brittleness we're escaping.
 *
 * Loop detection:
 *   Every act() call is wrapped in recordAndCheck() which:
 *     1. Records the action in the ActionLoopDetector
 *     2. Optionally captures a cheap DOM fingerprint for stagnation detection
 *     3. Prepends any nudge message to the *next* act() instruction
 *   The agent is never hard-blocked — nudges are informational context only.
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import { loadPolicy, evaluateExpense, type ExpenseItem } from '../policy/rules.js';
import { buildAccountantSystemPrompt, EXTRACT_EXPENSES_PROMPT } from '../policy/prompts.js';
import { writeToReviewQueue, type ReviewItem } from '../workflows/review-queue.js';
import { log } from '../utils/logger.js';
import { ActionLoopDetector, type RecordedAction } from './loop-detector.js';

export interface AgentRunOptions {
  dryRun?: boolean;
  targetUrl: string;
  credentials: {
    email: string;
    password: string;
  };
  /** Override loop detector window size (default: 20) */
  loopDetectorWindowSize?: number;
  /** Disable DOM fingerprint-based stagnation detection (default: enabled) */
  disableStagnationDetection?: boolean;
}

export interface RunSummary {
  totalReviewed: number;
  totalApproved: number;
  totalFlagged: number;
  totalSkipped: number;
  flaggedItems: ReviewItem[];
  durationMs: number;
  errors: string[];
  loopDetectorStats: ReturnType<ActionLoopDetector['getStats']>;
}

// ─── Wrapped act() with loop detection ──────────────────────────────────────

/**
 * Wraps stagehand.act() with loop detection.
 *
 * 1. Annotates the instruction with any pending nudge (injected as context prefix)
 * 2. Executes the (possibly annotated) act()
 * 3. Records the *original* instruction hash (not the annotated one — we don't
 *    want the nudge text itself to break normalization)
 * 4. Optionally takes a DOM fingerprint snapshot for stagnation detection
 */
async function recordAndCheck(
  stagehand: Stagehand,
  detector: ActionLoopDetector,
  instruction: string,
  options: {
    type?: RecordedAction['type'];
    params?: Record<string, unknown>;
    captureFingerprint?: boolean;
  } = {}
): Promise<void> {
  const { type = 'act', params, captureFingerprint = true } = options;

  // Annotate instruction with nudge if a loop is currently detected
  const annotated = detector.annotateInstruction(instruction);

  if (annotated !== instruction) {
    log.warn('[LoopDetector] Nudge injected into next act()', {
      nudge: annotated.split('\n\n')[0], // log only the nudge prefix
    });
  }

  await stagehand.act(annotated);

  // Record the *original* (un-annotated) action for hashing
  const action: RecordedAction = { type, instruction, params };
  detector.recordAction(action);

  // DOM fingerprint for stagnation detection
  // We access stagehand.page only for this lightweight read — no interaction.
  if (captureFingerprint) {
    try {
      const page = (stagehand as unknown as { page: { url(): string; evaluate<T>(fn: () => T): Promise<T> } }).page;
      const url = page.url();
      const [domText, elementCount] = await Promise.all([
        page.evaluate(() => (document.body?.innerText ?? '').slice(0, 50_000)),
        page.evaluate(() => document.querySelectorAll('*').length),
      ]);
      detector.recordPageState(url, domText, elementCount);
    } catch (err) {
      // Non-fatal — fingerprint is best-effort
      log.debug('[LoopDetector] Could not capture page fingerprint', { err });
    }
  }
}

// ─── Main agent ──────────────────────────────────────────────────────────────

export async function runAccountantAgent(
  stagehand: Stagehand,
  options: AgentRunOptions
): Promise<RunSummary> {
  const startTime = Date.now();
  const policy = loadPolicy();
  const systemPrompt = buildAccountantSystemPrompt(policy);
  void systemPrompt; // reserved for agent() calls

  const detector = new ActionLoopDetector({
    windowSize: options.loopDetectorWindowSize ?? 20,
  });

  const summary: RunSummary = {
    totalReviewed: 0,
    totalApproved: 0,
    totalFlagged: 0,
    totalSkipped: 0,
    flaggedItems: [],
    durationMs: 0,
    errors: [],
    loopDetectorStats: detector.getStats(),
  };

  try {
    // ── Step 1: Navigate ────────────────────────────────────────────────────
    log.info(`Navigating to ${options.targetUrl}`);
    await recordAndCheck(
      stagehand,
      detector,
      `Go to ${options.targetUrl}`,
      { type: 'navigate', params: { url: options.targetUrl } }
    );
    log.info('Page loaded');

    // ── Step 2: Log in ──────────────────────────────────────────────────────
    const loginActions = await stagehand.observe(
      'What login options are available on this page?'
    );
    log.info('Login page observed', { actions: loginActions });

    await recordAndCheck(
      stagehand,
      detector,
      `Fill in the email or username field with "${options.credentials.email}"`,
      { type: 'input', params: { text: options.credentials.email } }
    );
    await recordAndCheck(
      stagehand,
      detector,
      `Fill in the password field with "${options.credentials.password}"`,
      { type: 'input', params: { text: options.credentials.password } }
    );
    await recordAndCheck(
      stagehand,
      detector,
      'Click the Sign In, Log In, or Submit button to authenticate',
      { type: 'click' }
    );
    log.info('Login submitted — waiting for dashboard to load');

    await stagehand.observe('Confirm the login was successful and the dashboard is visible');
    log.info('Login confirmed');

    // ── Step 3: Navigate to approvals queue ─────────────────────────────────
    await recordAndCheck(
      stagehand,
      detector,
      'Navigate to the Approvals, Pending Expenses, or Review Queue section',
      { type: 'navigate' }
    );

    const pageContext = await stagehand.observe(
      'Describe what is on this page — is this the expense approvals or pending items view?'
    );
    log.info('Approvals page context', { context: pageContext });

    // ── Step 4: Extract all pending expense items ────────────────────────────
    log.info('Extracting pending expense items...');
    const extractedItems = await stagehand.extract({
      instruction: EXTRACT_EXPENSES_PROMPT,
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vendor: { type: 'string' },
            amount: { type: 'number' },
            category: { type: 'string' },
            date: { type: 'string' },
            hasReceipt: { type: 'boolean' },
            description: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['id', 'vendor', 'amount', 'category', 'hasReceipt'],
        },
      },
    }) as ExpenseItem[];

    log.info(`Found ${extractedItems.length} pending items`);
    summary.totalReviewed = extractedItems.length;

    // ── Step 5: Evaluate each item and act ──────────────────────────────────
    for (const item of extractedItems) {
      const { decision, reason } = evaluateExpense(item, policy);

      if (decision === 'auto_approve') {
        if (options.dryRun) {
          log.info(`[DRY RUN] Would approve: ${item.vendor} $${item.amount}`);
        } else {
          // The loop detector will catch if the agent keeps approving the same
          // item over and over (e.g., due to extract() returning duplicates).
          await recordAndCheck(
            stagehand,
            detector,
            `Click the Approve button for the expense from ${item.vendor} for $${item.amount}`,
            { type: 'click', params: { vendor: item.vendor, amount: item.amount } }
          );
          log.info(`Approved: ${item.vendor} $${item.amount} — ${reason}`);
        }
        summary.totalApproved++;
      } else {
        // Flag — write to review queue, NEVER click approve
        const reviewItem: ReviewItem = {
          id:
            (item as ExpenseItem & { id?: string }).id ??
            `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          vendor: item.vendor,
          amount: item.amount,
          category: item.category,
          hasReceipt: item.hasReceipt,
          flagReason: reason,
          decision,
          timestamp: new Date().toISOString(),
        };

        await writeToReviewQueue(reviewItem);
        summary.flaggedItems.push(reviewItem);
        summary.totalFlagged++;
        log.warn(`Flagged: ${item.vendor} $${item.amount} — ${reason}`);
      }
    }

    // ── Step 6: Escalation check ────────────────────────────────────────────
    const vendorCounts = summary.flaggedItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.vendor] = (acc[item.vendor] ?? 0) + 1;
      return acc;
    }, {});

    const totalFlaggedSpend = summary.flaggedItems.reduce((sum, i) => sum + i.amount, 0);

    for (const [vendor, count] of Object.entries(vendorCounts)) {
      if (count >= policy.escalation.vendor_flag_threshold) {
        log.warn(`ESCALATION: ${vendor} has ${count} flagged items — exceeds vendor threshold`);
      }
    }

    if (totalFlaggedSpend >= policy.escalation.total_flagged_spend_threshold) {
      log.warn(`ESCALATION: Total flagged spend $${totalFlaggedSpend} exceeds threshold`);
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push(message);
    log.error(`Agent error: ${message}`);
  } finally {
    summary.durationMs = Date.now() - startTime;
    summary.loopDetectorStats = detector.getStats();
  }

  return summary;
}
