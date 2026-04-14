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
    // ── Step 1: Navigate to the target URL ──────────────────────────────────
    // act() handles navigation — Stagehand resolves the URL internally.
    // No stagehand.page.goto() — we stay in the Stagehand abstraction layer.
    log.info(`Navigating to ${options.targetUrl}`);
    await stagehand.act(`Go to ${options.targetUrl}`);
    log.info('Page loaded');

    // ── Step 2: Log in ──────────────────────────────────────────────────────
    // observe() first so the agent understands the page structure before acting.
    // This is more reliable than blindly act()-ing — especially on login pages
    // that vary between SSO, magic link, and password flows.
    const loginActions = await stagehand.observe(
      'What login options are available on this page?'
    );
    log.info('Login page observed', { actions: loginActions });

    await stagehand.act(
      `Fill in the email or username field with "${options.credentials.email}"`
    );
    await stagehand.act(
      `Fill in the password field with "${options.credentials.password}"`
    );
    await stagehand.act('Click the Sign In, Log In, or Submit button to authenticate');
    log.info('Login submitted — waiting for dashboard to load');

    // Stagehand's act() internally waits for DOM settle (domSettleTimeoutMs).
    // No explicit waitForLoadState needed.
    await stagehand.observe('Confirm the login was successful and the dashboard is visible');
    log.info('Login confirmed');

    // ── Step 3: Navigate to approvals queue ─────────────────────────────────
    await stagehand.act(
      'Navigate to the Approvals, Pending Expenses, or Review Queue section'
    );

    // Verify we landed in the right place
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
          // act() naturally language-scopes the click to the right row.
          // Stagehand resolves which button corresponds to this vendor+amount.
          await stagehand.act(
            `Click the Approve button for the expense from ${item.vendor} for $${item.amount}`
          );
          log.info(`Approved: ${item.vendor} $${item.amount} — ${reason}`);
        }
        summary.totalApproved++;
      } else {
        // Flag — write to review queue, NEVER click approve
        const reviewItem: ReviewItem = {
          id: (item as ExpenseItem & { id?: string }).id ?? `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
    // If too many items from the same vendor are flagged, surface it explicitly.
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
  }

  return summary;
}
