/**
 * enrichment/enrich-transaction.ts
 *
 * The core enrichment engine.
 *
 * Traditional AP tools: binary — approve or flag.
 * This engine: reads the transaction like a senior accountant,
 * cross-references institutional knowledge, and generates targeted
 * questions for the cardholder before month-end close.
 *
 * The mental model: imagine a CFO leaning over your shoulder looking
 * at Ramp. They're not just checking the amount — they're thinking:
 *   "AWS on a Tuesday, $2,400 — that's the reserved instance billing,
 *    normal. But why is Marcus from Sales charging DoorDash at 11pm
 *    on a Sunday? And this Canva charge has no project code."
 *
 * enrichTransaction() takes a full screen-read of the transaction
 * page (whatever Stagehand extract() gives us) and returns:
 *   - verdict: approve | question | flag | escalate
 *   - cardholderQuestion: the specific question to post as a comment
 *   - educationNote: policy education for the cardholder if warranted
 *   - accountantReasoning: the internal logic (not shown to cardholder)
 *   - confidence: 0–1, how certain the LLM is
 *   - suggestedMemo: what the memo/description SHOULD say
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildKnowledgeContext, type KnowledgeBase } from './knowledge-base.js';
import type { Policy } from '../policy/rules.js';
import { log } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Everything the enrichment engine knows about a transaction.
 * Built from a Stagehand extract() call on the transaction detail page.
 */
export interface TransactionContext {
  /** Transaction ID in Ramp (or whatever platform) */
  transactionId: string;
  vendor: string;
  amount: number;
  currency: string;
  category: string;
  /** The cardholder's name as it appears on the platform */
  cardholderName: string;
  /** Cardholder's email if visible */
  cardholderEmail?: string;
  /** The memo / description the cardholder entered, if any */
  memoEntered?: string;
  /** Whether a receipt is attached */
  hasReceipt: boolean;
  /** Date of the transaction (ISO string) */
  transactionDate: string;
  /** Current submission/approval status in the platform */
  status: string;
  /** Any existing comments on the transaction */
  existingComments?: string[];
  /** Raw text content of the transaction page (from Stagehand observe/extract) */
  pageText?: string;
}

export type EnrichmentVerdict = 'approve' | 'question' | 'flag' | 'escalate';

export interface EnrichmentResult {
  transactionId: string;
  verdict: EnrichmentVerdict;

  /**
   * The question to post as a Ramp comment, addressed directly to the cardholder.
   * null when verdict === 'approve'.
   * Should be specific, one question, non-accusatory, educational in tone.
   * E.g. "Hi @sarah — can you confirm this was for the Q2 offsite and add
   * a note to the memo? Our policy requires project codes for all event spend."
   */
  cardholderQuestion: string | null;

  /**
   * Optional educational note about policy.
   * Posted alongside the question when the cardholder likely didn’t know the rule.
   * E.g. "📚 Policy note: meals over $75 require the attendee list and business purpose."
   */
  educationNote: string | null;

  /**
   * The accountant’s internal reasoning — NOT shown to the cardholder.
   * Stored in the audit trail and shown in the review dashboard.
   */
  accountantReasoning: string;

  /**
   * Confidence in the verdict (0–1).
   * Low confidence (<0.6) = always route to human review regardless of verdict.
   */
  confidence: number;

  /**
   * What the memo should say for this transaction to be compliant.
   * Used to guide the cardholder to correct format.
   */
  suggestedMemo: string | null;

  /** Whether institutional knowledge matched anything for this transaction */
  knowledgeBaseHit: boolean;

  /** ISO timestamp */
  enrichedAt: string;
}

// ── System prompt ───────────────────────────────────────────────────────────

const ENRICHMENT_SYSTEM_PROMPT = `You are a senior AP accountant reviewing corporate card transactions before month-end close.

You think like a human accountant who has been at this company for two years. You know the vendors, the team spend patterns, and the policy nuances. You are not a rules engine — you apply judgment.

Your job for each transaction:
1. Read the transaction details and any institutional context provided
2. Decide: is this clearly fine, does it need a question, should it be flagged, or escalated?
3. If it needs a question: write ONE specific, direct question for the cardholder
4. If the cardholder likely didn’t know the rule: add a brief education note
5. Think through your reasoning (internal, not shown to cardholder)
6. Suggest what the memo should say if it’s missing or incomplete

Verdict definitions:
  approve    — Transaction is clearly fine, no action needed
  question   — Transaction may be fine but needs cardholder clarification or better memo
  flag       — Transaction violates policy or looks wrong; needs human AP review
  escalate   — High value, sensitive vendor, or repeated pattern; needs manager/CFO attention

Question writing rules:
  - Address the cardholder by first name with @mention syntax: "Hi @FirstName —"
  - Ask ONE specific question. Not a list. Not multiple questions.
  - Be direct but not accusatory. Assume good intent.
  - Reference the specific amount and vendor: "...this $84 charge at Uber Eats..."
  - If it’s a memo issue: tell them exactly what to add
  - End with a clear ask, not a vague "please clarify"

Education note rules:
  - Only include if the cardholder probably didn’t know the rule
  - Keep it to one sentence
  - Start with "📚 Policy: " prefix
  - Do not repeat information already in the question

Output ONLY a JSON object with these exact fields:
{
  "verdict": "approve" | "question" | "flag" | "escalate",
  "cardholderQuestion": string | null,
  "educationNote": string | null,
  "accountantReasoning": string,
  "confidence": number (0.0 to 1.0),
  "suggestedMemo": string | null
}

No markdown. No explanation outside the JSON.`;

// ── enrichTransaction() ───────────────────────────────────────────────────────

export async function enrichTransaction(
  tx: TransactionContext,
  client: Anthropic,
  kb: KnowledgeBase,
  policy: Policy
): Promise<EnrichmentResult> {
  const txDate = new Date(tx.transactionDate);
  const dayOfMonth = txDate.getDate();

  const knowledgeContext = buildKnowledgeContext(
    tx.vendor,
    tx.cardholderName,
    dayOfMonth,
    kb
  );

  // Knowledge base hit = we found at least one matching vendor or employee record
  const { matchVendor, matchEmployee } = await import('./knowledge-base.js');
  const vendorHit = matchVendor(tx.vendor, kb);
  const employeeHit = matchEmployee(tx.cardholderName, kb);
  const knowledgeBaseHit = vendorHit !== null || employeeHit !== null;

  // Build the user message with full transaction context
  const userMessage = [
    `## Transaction to review`,
    `Transaction ID: ${tx.transactionId}`,
    `Vendor: ${tx.vendor}`,
    `Amount: $${tx.amount} ${tx.currency}`,
    `Category: ${tx.category}`,
    `Cardholder: ${tx.cardholderName}${tx.cardholderEmail ? ` (${tx.cardholderEmail})` : ''}`,
    `Date: ${tx.transactionDate} (day ${dayOfMonth} of month)`,
    `Receipt attached: ${tx.hasReceipt ? 'Yes' : 'No'}`,
    `Status: ${tx.status}`,
    `Memo entered: ${tx.memoEntered ?? '(none)'}`,
    tx.existingComments?.length
      ? `Existing comments:\n${tx.existingComments.map(c => `  - ${c}`).join('\n')}`
      : '',
    tx.pageText ? `\nRaw page content (screen read):\n${tx.pageText.slice(0, 3000)}` : '',
    ``,
    `## Policy limits`,
    `Auto-approve under: $${policy.limits.auto_approve_under}`,
    `Flag for review over: $${policy.limits.flag_for_review_over}`,
    `Receipt required over: $${policy.limits.require_receipt_over}`,
    `Allowed categories: ${policy.categories.allowed.join(', ')}`,
    `Always-flag categories: ${policy.categories.always_flag.join(', ')}`,
    ``,
    `## Institutional knowledge`,
    knowledgeContext,
  ]
    .filter(Boolean)
    .join('\n');

  const model = process.env.COMP_CONTROL_ENRICH_MODEL ?? 'claude-sonnet-4-5';
  // Enrichment uses Sonnet by default (not Haiku) — this is a judgment call,
  // not a mechanical classification. The quality of the cardholder question
  // matters. Haiku is fast and cheap but occasionally misses nuance.

  let rawResponse = '';

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 1024,
      system: ENRICHMENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    rawResponse =
      message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

    const cleaned = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as {
      verdict: EnrichmentVerdict;
      cardholderQuestion: string | null;
      educationNote: string | null;
      accountantReasoning: string;
      confidence: number;
      suggestedMemo: string | null;
    };

    // Enforce: approve verdict cannot have a question
    if (parsed.verdict === 'approve') {
      parsed.cardholderQuestion = null;
      parsed.educationNote = null;
    }

    // Enforce: low confidence always routes to question/flag
    if (parsed.confidence < 0.6 && parsed.verdict === 'approve') {
      parsed.verdict = 'question';
      parsed.cardholderQuestion =
        parsed.cardholderQuestion ??
        `Hi @${tx.cardholderName.split(' ')[0]} — can you add a brief memo describing the business purpose of this $${tx.amount} charge at ${tx.vendor}?`;
    }

    log.info(`[Enrich] ${tx.vendor} $${tx.amount} → ${parsed.verdict} (confidence: ${parsed.confidence})`);

    return {
      transactionId: tx.transactionId,
      verdict: parsed.verdict,
      cardholderQuestion: parsed.cardholderQuestion,
      educationNote: parsed.educationNote,
      accountantReasoning: parsed.accountantReasoning,
      confidence: parsed.confidence,
      suggestedMemo: parsed.suggestedMemo,
      knowledgeBaseHit,
      enrichedAt: new Date().toISOString(),
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[Enrich] Failed for ${tx.vendor} $${tx.amount}: ${msg}`);

    // Fail safe: flag for human review, never silently approve on error
    return {
      transactionId: tx.transactionId,
      verdict: 'flag',
      cardholderQuestion: null,
      educationNote: null,
      accountantReasoning: `Enrichment failed: ${msg}. Routed to human review.`,
      confidence: 0,
      suggestedMemo: null,
      knowledgeBaseHit,
      enrichedAt: new Date().toISOString(),
    };
  }
}

/**
 * Batch enrich a list of transactions.
 * Processes sequentially (not parallel) to avoid rate limits on long queues.
 * Pass concurrency=N to process N at a time if your Anthropic tier allows it.
 */
export async function enrichTransactionBatch(
  transactions: TransactionContext[],
  client: Anthropic,
  kb: KnowledgeBase,
  policy: Policy,
  concurrency = 1
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = [];

  if (concurrency <= 1) {
    for (const tx of transactions) {
      results.push(await enrichTransaction(tx, client, kb, policy));
    }
    return results;
  }

  // Chunked parallel processing
  for (let i = 0; i < transactions.length; i += concurrency) {
    const chunk = transactions.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(tx => enrichTransaction(tx, client, kb, policy))
    );
    results.push(...chunkResults);
  }

  return results;
}
