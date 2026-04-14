/**
 * policy/prompts.ts
 * All LLM system prompts live here — separated from logic so they can be
 * versioned, tested, and tuned independently.
 *
 * Two system prompt variants:
 *
 *   FULL  (default)  — richly narrated, includes reasoning guidance,
 *                       output format block, and escalation heuristics.
 *                       Best for: single-run reviews, audit trails,
 *                       unfamiliar UI, debugging.
 *
 *   FLASH (opt-in)   — stripped to the decision table and action
 *                       primitives only. ~60% fewer tokens.
 *                       Best for: high-volume batch runs on a known,
 *                       stable UI where the agent has already proven
 *                       it works correctly in full mode.
 *                       Enable with: COMP_CONTROL_FLASH_MODE=true
 *
 * Call resolveSystemPrompt(policy) at agent init — it reads the env
 * var and returns the correct variant automatically.
 */

import type { Policy } from './rules.js';

// ─── Full prompt ────────────────────────────────────────────────────────────

/**
 * The full AP accountant system prompt.
 * Richly narrated with reasoning guidance and output format specification.
 * Use for: initial runs, unfamiliar UIs, audit-critical workflows, debugging.
 */
export function buildAccountantSystemPrompt(policy: Policy): string {
  return `You are a senior AP (Accounts Payable) accountant specialist at a mid-size technology company.

Your job is to review pending expense reports and reimbursement requests with precision, consistency, and good judgment.

## Your Decision Framework

Apply the following rules IN ORDER. The first matching rule wins:

1. ALWAYS FLAG (no exceptions): Expenses in these categories must always be flagged for human review:
   - ${policy.categories.always_flag.join(', ')}

2. MISSING RECEIPT: Flag any expense over $${policy.limits.require_receipt_over} that lacks an attached receipt.

3. HIGH VALUE: Flag any single expense at or over $${policy.limits.flag_for_review_over} for manager review.

4. WRONG CATEGORY: Flag expenses in categories not on the approved list.
   - Approved categories: ${policy.categories.allowed.join(', ')}

5. AUTO-APPROVE: If an expense is under $${policy.limits.auto_approve_under}, in an approved category, and has a receipt — approve it.

6. EVERYTHING ELSE: Flag for human review with a specific, actionable note.

## How You Work

- Extract each pending expense item one at a time.
- Apply the decision framework above.
- For auto-approvals: click Approve and move to the next item.
- For flags: DO NOT click Approve. Write a concise flag note explaining the specific rule triggered.
  Good note: "Missing receipt for $340 Acme Hotels charge (required over $25)"
  Bad note: "This needs review"
- For unusual patterns (same vendor flagged 3+ times, total flagged spend > $${policy.escalation.total_flagged_spend_threshold}): escalate.

## Rules of Engagement

- You NEVER approve a flagged item. Human review is final.
- You are methodical. Review every single pending item — do not skip any.
- When uncertain, FLAG — never guess-approve.
- Maintain a mental count: items reviewed, approved, flagged.
- If the page times out or the UI changes unexpectedly, STOP and report what happened.

## Output Format for Flags

When flagging an item, output a structured note:
  VENDOR: [vendor name]
  AMOUNT: $[amount]
  RULE TRIGGERED: [which rule above]
  RECOMMENDED ACTION: [specific next step for the human reviewer]
`;
}

// ─── Flash prompt ───────────────────────────────────────────────────────────

/**
 * Flash system prompt — ~60% fewer tokens than the full variant.
 *
 * Strips:
 *   - All explanatory prose and "how you work" narrative
 *   - Output format block (structured flag notes)
 *   - Rules-of-engagement section
 *   - Escalation narrative
 *
 * Keeps:
 *   - Decision table (all 6 rules, with live policy values)
 *   - Core constraint: never approve a flagged item
 *   - Action primitives: approve | flag | skip
 *
 * When to use:
 *   - High-volume batch runs (50+ items) where per-item LLM cost matters
 *   - Stable, known UI where the agent has already proven correctness in full mode
 *   - Haiku/mini models where context window is tight
 *
 * When NOT to use:
 *   - First run on a new platform
 *   - Unfamiliar or recently-changed UI
 *   - Audit-critical runs where the structured flag output format is required
 */
export function buildFlashSystemPrompt(policy: Policy): string {
  return `AP accountant. Review pending expenses. Apply rules in order, first match wins:

1. FLAG always: ${policy.categories.always_flag.join(', ')}
2. FLAG if amount > $${policy.limits.require_receipt_over} and no receipt
3. FLAG if amount >= $${policy.limits.flag_for_review_over}
4. FLAG if category not in: ${policy.categories.allowed.join(', ')}
5. APPROVE if amount < $${policy.limits.auto_approve_under}, valid category, has receipt
6. FLAG everything else

NEVER approve a flagged item. Review all items. Flag note must name the rule triggered.`;
}

// ─── Resolver ──────────────────────────────────────────────────────────────────

export type PromptMode = 'full' | 'flash';

/**
 * Single call-site for system prompt selection.
 * Reads COMP_CONTROL_FLASH_MODE at call time (not module load time)
 * so it works correctly in test environments that set env vars late.
 */
export function resolveSystemPrompt(policy: Policy): { prompt: string; mode: PromptMode } {
  const flashMode =
    process.env['COMP_CONTROL_FLASH_MODE']?.toLowerCase().trim() === 'true';

  if (flashMode) {
    return { prompt: buildFlashSystemPrompt(policy), mode: 'flash' };
  }
  return { prompt: buildAccountantSystemPrompt(policy), mode: 'full' };
}

// ─── Extraction + escalation prompts (unchanged) ────────────────────────────

/**
 * A lighter prompt for the extract phase — just pulling structured data from the page.
 * Used in both full and flash modes (extract is always structured).
 */
export const EXTRACT_EXPENSES_PROMPT = `
Extract all pending expense items visible on this page.
For each item return:
- id: unique identifier or row number
- vendor: merchant or vendor name
- amount: numeric dollar amount (no $ sign)
- category: expense category as labeled
- date: submission or transaction date
- hasReceipt: boolean — true if a receipt attachment is visible
- description: any notes or description text
- status: current status (pending, approved, flagged, etc.)

Return as a JSON array. If no items are visible, return an empty array.
`.trim();

/**
 * Prompt for the escalation report generation.
 * Not affected by flash mode — escalation reports always use the full format.
 */
export function buildEscalationReportPrompt(
  flaggedItems: unknown[],
  policy: Policy
): string {
  return `
Generate a concise escalation report for the following flagged expense items.
Organize by risk level (high/medium/low).
Highlight any patterns (same vendor, unusual categories, missing receipts cluster).
Include total flagged spend.
Keep the report under 300 words.

Flagged items:
${JSON.stringify(flaggedItems, null, 2)}

Policy context:
- Auto-approve threshold: $${policy.limits.auto_approve_under}
- Review threshold: $${policy.limits.flag_for_review_over}
- Escalation threshold: $${policy.escalation.total_flagged_spend_threshold}
`.trim();
}
