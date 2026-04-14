/**
 * enrichment/comment-writer.ts
 *
 * Formats EnrichmentResult into a Ramp comment and posts it via Stagehand.
 *
 * The comment is the product — it's what the cardholder actually sees.
 * Format priorities:
 *   1. Direct and specific. Not "please provide more information."
 *      "Hi @Sarah — can you confirm this $84 DoorDash charge was a team
 *       lunch and add the attendee count to the memo?"
 *   2. One question only. Multiple questions get ignored.
 *   3. Education note if policy was probably unknown (brief, not preachy).
 *   4. Suggested memo format so the fix is obvious.
 *
 * Stagehand flow:
 *   1. Navigate to the transaction detail page
 *   2. observe() — confirm comment box is present
 *   3. act() — click the comment/note field
 *   4. act() — type the comment text
 *   5. act() — submit
 *
 * The @mention syntax ("@Sarah") works in Ramp's comment system and
 * triggers a notification to that cardholder. No separate notification
 * API call needed.
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import type { EnrichmentResult } from './enrich-transaction.js';
import type { TransactionContext } from './enrich-transaction.js';
import { log } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface CardholderComment {
  /** The full formatted comment body ready to post */
  body: string;
  /** First name extracted from cardholderName for @mention */
  mentionName: string;
  /** Whether an education note was included */
  includesEducation: boolean;
  /** Whether a suggested memo format was included */
  includesSuggestedMemo: boolean;
}

export interface PostCommentResult {
  transactionId: string;
  posted: boolean;
  commentBody: string;
  dryRun: boolean;
  error?: string;
}

// ── Comment builder ────────────────────────────────────────────────────────

/**
 * Build the formatted comment body from an EnrichmentResult.
 * Does NOT post anything — pure formatting function, easy to test.
 */
export function buildRampComment(
  result: EnrichmentResult,
  tx: TransactionContext
): CardholderComment {
  const firstName = tx.cardholderName.split(' ')[0] ?? tx.cardholderName;
  const mentionName = firstName;

  const parts: string[] = [];

  // ── Main question ───────────────────────────────────────────────────
  if (result.cardholderQuestion) {
    // The LLM already writes this with @mention — use as-is if it starts
    // with "Hi @". Otherwise wrap it.
    if (result.cardholderQuestion.startsWith('Hi @')) {
      parts.push(result.cardholderQuestion);
    } else {
      parts.push(`Hi @${mentionName} — ${result.cardholderQuestion}`);
    }
  } else if (result.verdict === 'flag' || result.verdict === 'escalate') {
    // Fallback when the LLM didn't generate a question but verdict needs action
    parts.push(
      `Hi @${mentionName} — this $${tx.amount} charge at ${tx.vendor} has been flagged for AP review. ` +
      `Please add a memo with the business purpose.`
    );
  }

  // ── Education note ──────────────────────────────────────────────────
  let includesEducation = false;
  if (result.educationNote) {
    parts.push(result.educationNote);
    includesEducation = true;
  }

  // ── Suggested memo ──────────────────────────────────────────────────
  let includesSuggestedMemo = false;
  if (result.suggestedMemo) {
    parts.push(`Suggested memo: _"${result.suggestedMemo}"_`);
    includesSuggestedMemo = true;
  }

  // ── Flag indicator (for escalated items) ────────────────────────────
  if (result.verdict === 'escalate') {
    parts.push(`🚨 This transaction has been escalated for manager review.`);
  }

  const body = parts.join('\n\n');

  return { body, mentionName, includesEducation, includesSuggestedMemo };
}

// ── Stagehand poster ───────────────────────────────────────────────────────

/**
 * Post a comment on a Ramp transaction using Stagehand.
 *
 * Navigation assumption: the agent is already on the Ramp approvals/transactions
 * page. This function navigates to the specific transaction, posts the comment,
 * and returns to the list view.
 *
 * Stagehand's act() handles the selector variance across Ramp UI versions —
 * we describe intent in natural language, not CSS selectors.
 */
export async function postRampComment(
  stagehand: Stagehand,
  tx: TransactionContext,
  result: EnrichmentResult,
  options: { dryRun?: boolean; baseUrl?: string } = {}
): Promise<PostCommentResult> {
  const { dryRun = false } = options;
  const comment = buildRampComment(result, tx);

  if (result.verdict === 'approve') {
    // No comment needed for approved transactions
    return {
      transactionId: tx.transactionId,
      posted: false,
      commentBody: '',
      dryRun,
    };
  }

  if (dryRun) {
    log.info(`[DRY RUN] Would post comment on ${tx.vendor} $${tx.amount}:`);
    log.info(comment.body);
    return {
      transactionId: tx.transactionId,
      posted: false,
      commentBody: comment.body,
      dryRun: true,
    };
  }

  try {
    // Navigate to the transaction detail
    await stagehand.act(
      `Click on the transaction from ${tx.vendor} for $${tx.amount} ` +
      `on ${tx.transactionDate} by ${tx.cardholderName} to open its detail view`
    );

    // Confirm we're on the right page
    await stagehand.observe(
      `Confirm this is the detail page for the ${tx.vendor} $${tx.amount} transaction`
    );

    // Find and click the comment/note input
    await stagehand.act(
      'Click on the comment, note, or message field for this transaction'
    );

    // Type the comment (Stagehand handles the actual keystroke simulation)
    await stagehand.act(
      `Type the following comment exactly as written:\n\n${comment.body}`
    );

    // Submit
    await stagehand.act(
      'Click the Submit, Post, or Send button to post this comment'
    );

    // Confirm it posted
    await stagehand.observe(
      `Confirm the comment "${comment.body.slice(0, 60)}" was posted successfully`
    );

    log.info(
      `[CommentWriter] Posted comment on ${tx.vendor} $${tx.amount} — @${comment.mentionName} tagged`
    );

    // Navigate back to the queue
    await stagehand.act('Click the back button or navigate back to the transactions list');

    return {
      transactionId: tx.transactionId,
      posted: true,
      commentBody: comment.body,
      dryRun: false,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[CommentWriter] Failed to post comment on ${tx.vendor}: ${msg}`);
    return {
      transactionId: tx.transactionId,
      posted: false,
      commentBody: comment.body,
      dryRun: false,
      error: msg,
    };
  }
}

/**
 * Process a batch of enrichment results and post comments for all
 * transactions that need cardholder action.
 */
export async function postCommentBatch(
  stagehand: Stagehand,
  transactions: TransactionContext[],
  results: EnrichmentResult[],
  options: { dryRun?: boolean } = {}
): Promise<PostCommentResult[]> {
  const postResults: PostCommentResult[] = [];

  for (const result of results) {
    if (result.verdict === 'approve') continue;

    const tx = transactions.find(t => t.transactionId === result.transactionId);
    if (!tx) continue;

    const postResult = await postRampComment(stagehand, tx, result, options);
    postResults.push(postResult);
  }

  return postResults;
}
