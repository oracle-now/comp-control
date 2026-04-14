/**
 * agents/accountant.agent.ts
 * The core AP accountant agent.
 *
 * Responsibilities:
 *  1. Navigate to the target expense platform
 *  2. Log in
 *  3. Extract all pending expense items
 *  4. Apply policy rules to each item
 *  5. Auto-approve or flag
 *  6. Write flagged items to the review queue
 *  7. Generate a run summary
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import { loadPolicy, evaluateExpense, type ExpenseItem } from '../policy/rules.js';
import { buildAccountantSystemPrompt, EXTRACT_EXPENSES_PROMPT } from '../policy/prompts.js';
import { writeToReviewQueue, type ReviewItem } from '../workflows/review-queue.js';
import { log } from '../utils/logger.js';

export interface AgentRunOptions {
  dryRun?: boolean;
  targetUrl: string;
  credentials: {
    email: string;
    password: string;
  };
}

export interface RunSummary {
  totalReviewed: number;
  totalApproved: number;
  totalFlagged: number;
  totalSkipped: number;
  flaggedItems: ReviewItem[];
  durationMs: number;
  errors: string[];
}

export async function runAccountantAgent(
  stagehand: Stagehand,
  options: AgentRunOptions
): Promise<RunSummary> {
  const startTime = Date.now();
  const policy = loadPolicy();
  const systemPrompt = buildAccountantSystemPrompt(policy);
  const summary: RunSummary = {
    totalReviewed: 0,
    totalApproved: 0,
    totalFlagged: 0,
    totalSkipped: 0,
    flaggedItems: [],
    durationMs: 0,
    errors: [],
  };

  try {
    // ── Step 1: Navigate and log in ─────────────────────────────────────────
    log.info(`Navigating to ${options.targetUrl}`);
    await stagehand.page.goto(options.targetUrl);

    // The agent figures out the login form structure via observe
    await stagehand.act(`Fill in the email field with "${options.credentials.email}"`);
    await stagehand.act(`Fill in the password field with "${options.credentials.password}"`);
    await stagehand.act('Click the Sign In or Log In button');
    await stagehand.page.waitForLoadState('networkidle');
    log.info('Login complete');

    // ── Step 2: Navigate to approvals / pending queue ────────────────────────
    await stagehand.act('Navigate to the Approvals or Pending Expenses section');
    await stagehand.page.waitForLoadState('networkidle');

    // ── Step 3: Extract all pending items ───────────────────────────────────
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

    // ── Step 4: Evaluate each item and act ──────────────────────────────────
    for (const item of extractedItems) {
      const { decision, reason } = evaluateExpense(item, policy);

      if (decision === 'auto_approve') {
        if (options.dryRun) {
          log.info(`[DRY RUN] Would approve: ${item.vendor} $${item.amount}`);
        } else {
          await stagehand.act(
            `Click the Approve button for the expense from ${item.vendor} for $${item.amount}`
          );
          log.info(`Approved: ${item.vendor} $${item.amount} — ${reason}`);
        }
        summary.totalApproved++;
      } else {
        // Flag — write to review queue, do NOT click approve
        const reviewItem: ReviewItem = {
          id: item.id ?? `item-${Date.now()}`,
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push(message);
    log.error(`Agent error: ${message}`);
  } finally {
    summary.durationMs = Date.now() - startTime;
  }

  return summary;
}
