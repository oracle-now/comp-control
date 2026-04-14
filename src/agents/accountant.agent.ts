/**
 * agents/accountant.agent.ts
 * The core AP accountant agent — pure Stagehand, zero raw Playwright.
 *
 * Post-run judgement:
 *   After the approval loop finishes, judgeRun() is called with the full
 *   step log and RunSummary. Claude returns a JudgementResult, which is:
 *     - attached to RunSummary.judgement
 *     - written to resolved.json via writeRunJudgement()
 *   If the judge call fails, a synthetic 'failure' record is written so
 *   the audit trail is never broken.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Stagehand } from '@browserbasehq/stagehand';
import { loadPolicy, evaluateExpense, type ExpenseItem } from '../policy/rules.js';
import {
  resolveSystemPrompt,
  EXTRACT_EXPENSES_PROMPT,
  type PromptMode,
} from '../policy/prompts.js';
import { writeToReviewQueue, writeRunJudgement, type ReviewItem } from '../workflows/review-queue.js';
import { log } from '../utils/logger.js';
import { ActionLoopDetector, type RecordedAction } from './loop-detector.js';
import { StepHistory } from '../memory/summarize-history.js';
import { judgeRun, type JudgementResult, type JudgeRunInput } from '../memory/judge-run.js';

export interface AgentRunOptions {
  dryRun?: boolean;
  targetUrl: string;
  credentials: {
    email: string;
    password: string;
  };
  loopDetectorWindowSize?: number;
  compaction?: {
    compactEveryNSteps?: number;
    triggerCharCount?: number;
    keepLast?: number;
  };
  /**
   * Set false to skip post-run judgement (e.g. in unit tests or dry-runs
   * where you don't want to pay for the judge API call).
   * Default: true.
   */
  skipJudgement?: boolean;
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
  historyStats: ReturnType<StepHistory['getStats']>;
  promptMode: PromptMode;
  /**
   * JudgementResult written after the run.
   * null if skipJudgement=true or the run ended before the judge was called.
   */
  judgement: JudgementResult | null;
}

// ─── Wrapped act() with loop detection ──────────────────────────────────────

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
  const annotated = detector.annotateInstruction(instruction);
  if (annotated !== instruction) {
    log.warn('[LoopDetector] Nudge injected', { nudge: annotated.split('\n\n')[0] });
  }
  await stagehand.act(annotated);
  const action: RecordedAction = { type, instruction, params };
  detector.recordAction(action);
  if (captureFingerprint) {
    try {
      const page = (stagehand as unknown as {
        page: { url(): string; evaluate<T>(fn: () => T): Promise<T> };
      }).page;
      const url = page.url();
      const [domText, elementCount] = await Promise.all([
        page.evaluate(() => (document.body?.innerText ?? '').slice(0, 50_000)),
        page.evaluate(() => document.querySelectorAll('*').length),
      ]);
      detector.recordPageState(url, domText, elementCount);
    } catch (err) {
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

  const { prompt: systemPrompt, mode: promptMode } = resolveSystemPrompt(policy);
  void systemPrompt;

  const detector = new ActionLoopDetector({
    windowSize: options.loopDetectorWindowSize ?? 20,
  });

  const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  const history = new StepHistory({
    compactEveryNSteps: options.compaction?.compactEveryNSteps ?? 25,
    triggerCharCount: options.compaction?.triggerCharCount ?? 40_000,
    keepLast: options.compaction?.keepLast ?? 6,
  });

  log.info('[Agent] Starting run', {
    promptMode,
    dryRun: options.dryRun ?? false,
    targetUrl: options.targetUrl,
  });

  if (promptMode === 'flash') {
    log.warn(
      '[Agent] Flash mode active — stripped system prompt. ' +
      'Only use on known-stable UIs verified in full mode first.'
    );
  }

  const summary: RunSummary = {
    totalReviewed: 0,
    totalApproved: 0,
    totalFlagged: 0,
    totalSkipped: 0,
    flaggedItems: [],
    durationMs: 0,
    errors: [],
    loopDetectorStats: detector.getStats(),
    historyStats: history.getStats(),
    promptMode,
    judgement: null,
  };

  try {
    // ── Step 1: Navigate
    log.info(`Navigating to ${options.targetUrl}`);
    await recordAndCheck(stagehand, detector,
      `Go to ${options.targetUrl}`,
      { type: 'navigate', params: { url: options.targetUrl } }
    );
    history.record({
      stepNumber: 1,
      action: `Navigated to ${options.targetUrl}`,
      outcome: 'navigate',
      url: options.targetUrl,
      timestampMs: Date.now(),
    });

    // ── Step 2: Log in
    await stagehand.observe('What login options are available on this page?');
    await recordAndCheck(stagehand, detector,
      `Fill in the email or username field with "${options.credentials.email}"`,
      { type: 'input', params: { text: options.credentials.email } }
    );
    await recordAndCheck(stagehand, detector,
      `Fill in the password field with "${options.credentials.password}"`,
      { type: 'input', params: { text: options.credentials.password } }
    );
    await recordAndCheck(stagehand, detector,
      'Click the Sign In, Log In, or Submit button to authenticate',
      { type: 'click' }
    );
    await stagehand.observe('Confirm the login was successful and the dashboard is visible');
    history.record({
      stepNumber: 2,
      action: 'Logged in successfully',
      outcome: 'navigate',
      timestampMs: Date.now(),
    });
    log.info('Login confirmed');

    // ── Step 3: Navigate to approvals queue
    await recordAndCheck(stagehand, detector,
      'Navigate to the Approvals, Pending Expenses, or Review Queue section',
      { type: 'navigate' }
    );
    await stagehand.observe(
      'Describe what is on this page — is this the expense approvals or pending items view?'
    );
    history.record({
      stepNumber: 3,
      action: 'Navigated to approvals queue',
      outcome: 'navigate',
      timestampMs: Date.now(),
    });

    // ── Step 4: Extract pending items
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

    // ── Step 5: Evaluate each item
    let stepN = 4;

    for (const item of extractedItems) {
      const { decision, reason } = evaluateExpense(item, policy);

      if (history.shouldCompact()) {
        log.info(
          `[History] Compacting ${history.compactable.length} steps ` +
          `(keeping last ${history.recent.length} verbatim)...`
        );
        const compacted = await history.compact(anthropic);
        log.info(`[History] Compacted ${compacted.summarizedStepCount} steps`);
      }

      const contextPrefix = history.toContextPrefix();

      if (decision === 'auto_approve') {
        if (options.dryRun) {
          log.info(`[DRY RUN] Would approve: ${item.vendor} $${item.amount}`);
          history.record({
            stepNumber: stepN++,
            action: `[DRY RUN] Would approve ${item.vendor} $${item.amount}`,
            outcome: 'approved',
            detail: `${item.vendor} $${item.amount} — ${reason}`,
            timestampMs: Date.now(),
          });
        } else {
          const instruction = contextPrefix
            ? `${contextPrefix}\n\nNow: Click the Approve button for the expense from ${item.vendor} for $${item.amount}`
            : `Click the Approve button for the expense from ${item.vendor} for $${item.amount}`;
          await recordAndCheck(stagehand, detector, instruction, {
            type: 'click',
            params: { vendor: item.vendor, amount: item.amount },
          });
          history.record({
            stepNumber: stepN++,
            action: `Approved ${item.vendor} $${item.amount}`,
            outcome: 'approved',
            detail: reason,
            timestampMs: Date.now(),
          });
          log.info(`Approved: ${item.vendor} $${item.amount}`);
        }
        summary.totalApproved++;
      } else {
        const reviewItem: ReviewItem = {
          id: (item as ExpenseItem & { id?: string }).id ??
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
        history.record({
          stepNumber: stepN++,
          action: `Flagged ${item.vendor} $${item.amount}`,
          outcome: 'flagged',
          detail: reason,
          timestampMs: Date.now(),
        });
        log.warn(`Flagged: ${item.vendor} $${item.amount} — ${reason}`);
      }
    }

    // ── Step 6: Escalation check
    const vendorCounts = summary.flaggedItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.vendor] = (acc[item.vendor] ?? 0) + 1;
      return acc;
    }, {});
    const totalFlaggedSpend = summary.flaggedItems.reduce((sum, i) => sum + i.amount, 0);
    for (const [vendor, count] of Object.entries(vendorCounts)) {
      if (count >= policy.escalation.vendor_flag_threshold) {
        log.warn(`ESCALATION: ${vendor} has ${count} flagged items`);
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
    summary.historyStats = history.getStats();
  }

  // ── Step 7: Post-run judgement ────────────────────────────────────────────
  // Runs OUTSIDE the try/catch so errors in the approval loop don't prevent
  // the judgement from firing. The judge sees the full step log including
  // any partial progress before the error.
  if (!(options.skipJudgement ?? false)) {
    try {
      log.info('[Judge] Calling post-run judge...');
      const judgeInput: JudgeRunInput = {
        steps: history.all,
        summary,
        targetUrl: options.targetUrl,
      };
      const judgement = await judgeRun(judgeInput, anthropic);
      summary.judgement = judgement;

      const record = writeRunJudgement(judgement);
      log.info(`[Judge] Written to resolved.json as runId: ${record.runId}`);

      // Surface critical flags in the run log for visibility
      if (judgement.reachedCaptcha) {
        log.warn('[Judge] CAPTCHA detected in run — consider rotating session or enabling Browserbase anti-detect');
      }
      if (judgement.verdict === 'failure') {
        log.error(`[Judge] Run verdict: FAILURE — ${judgement.failureReason ?? 'unknown reason'}`);
      } else if (judgement.verdict === 'partial') {
        log.warn(`[Judge] Run verdict: PARTIAL — ${judgement.failureReason ?? ''}`);
      } else {
        log.info('[Judge] Run verdict: SUCCESS');
      }
    } catch (judgeErr) {
      // judgeRun() is already try/catch internally, but belt-and-suspenders
      const msg = judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
      log.error(`[Judge] Unexpected error in judgement step: ${msg}`);
    }
  }

  return summary;
}
