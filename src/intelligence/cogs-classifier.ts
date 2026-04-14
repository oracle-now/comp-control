/**
 * intelligence/cogs-classifier.ts
 *
 * GL code classification for corporate card charges.
 *
 * For a SaaS company, this is the highest-impact AP judgment call.
 * A $2,400 AWS charge classified as COGS vs R&D changes your gross
 * margin by $2,400. Multiply that by 200 charges a month and wrong
 * GL coding silently corrupts every financial statement you produce.
 *
 * What this module does:
 *   1. Classifies each transaction into a GL bucket using vendor,
 *      cardholder role, category, and memo as signals
 *   2. Flags ambiguous charges where the classification genuinely
 *      depends on how the charge was used (e.g. AWS prod vs dev)
 *   3. Drafts the specific question to ask the cardholder when
 *      the answer changes the GL code
 *   4. Learns from the knowledge base — if we already know that
 *      Marcus's AWS is always dev, skip the question
 *
 * GL buckets (configurable in config/gl-codes.yaml):
 *   COGS          — direct cost of delivering your product/service
 *   RD            — research & development
 *   SM            — sales & marketing
 *   GA            — general & administrative
 *   CAPEX         — capital expenditure (rare on cards, but happens)
 *   PREPAID       — annual subscriptions that should be amortized
 *   INTERCOMPANY  — charges between related entities
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TransactionContext } from '../enrichment/enrich-transaction.js';
import type { KnowledgeBase } from '../enrichment/knowledge-base.js';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type GLBucket =
  | 'COGS'
  | 'RD'
  | 'SM'
  | 'GA'
  | 'CAPEX'
  | 'PREPAID'
  | 'INTERCOMPANY'
  | 'UNKNOWN';

export interface GLClassification {
  transactionId: string;
  vendor: string;
  amount: number;

  /** Primary GL bucket assigned */
  glBucket: GLBucket;

  /** Specific GL account code from your chart of accounts, if matched */
  glCode: string | null;

  /** Human-readable GL account name */
  glAccountName: string | null;

  /**
   * How confident we are (0–1).
   * < 0.7: needs cardholder confirmation before booking
   * 0.7–0.9: classify but note as AI-assisted
   * > 0.9: classify with high confidence, no question needed
   */
  confidence: number;

  /**
   * Whether classification is ambiguous and depends on usage context.
   * True = we need to ask the cardholder before we can book this.
   * E.g. AWS can be COGS (prod) or R&D (dev environment).
   */
  isAmbiguous: boolean;

  /**
   * The specific question to ask the cardholder to resolve ambiguity.
   * Only populated when isAmbiguous === true.
   * Framed as a GL question, not a policy violation.
   */
  clarificationQuestion: string | null;

  /**
   * The accountant's reasoning for this classification.
   * Stored in audit trail. Never shown to cardholder.
   */
  reasoning: string;

  /** Whether this should be treated as a prepaid and amortized */
  isPrepaid: boolean;

  /** Estimated amortization months if isPrepaid */
  amortizationMonths: number | null;

  classifiedAt: string;
}

// ── GL code lookup from config ────────────────────────────────────────────

export interface GLCodeMap {
  COGS: string;
  RD: string;
  SM: string;
  GA: string;
  CAPEX: string;
  PREPAID: string;
  [key: string]: string;
}

// ── System prompt ────────────────────────────────────────────────────────

const COGS_CLASSIFIER_PROMPT = `You are a senior accountant specializing in SaaS company GL coding.

Your job is to classify corporate card transactions into the correct GL bucket.
This directly affects gross margin, EBITDA, and every financial ratio the company reports.
Get it right. When uncertain, flag for clarification rather than guess.

GL BUCKET DEFINITIONS:

COGS (Cost of Goods Sold / Cost of Revenue):
  Direct costs to DELIVER the product to customers.
  For SaaS: production hosting (AWS/GCP prod), customer support tools,
  data costs for the product, third-party APIs embedded in the product,
  monitoring/observability for prod systems, professional services for customers.
  NOT COGS: dev environments, internal tools, anything that would exist
  even if you had zero customers.

RD (Research & Development):
  Building new features or improving the product.
  For SaaS: dev/staging hosting, engineering tools (GitHub, Linear, Figma),
  dev API keys, testing infrastructure, R&D employee tools.
  Key question: "Would this cost go away if we stopped building new features?"

SM (Sales & Marketing):
  Acquiring and retaining customers.
  For SaaS: CRM tools, advertising, conference sponsorships, AE travel,
  client meals, marketing software, SDR tools.

GA (General & Administrative):
  Running the company, not related to product or sales.
  For SaaS: legal, accounting/finance tools, HR platforms, office expenses,
  exec assistant tools, company-wide software (Slack, Google Workspace),
  compliance tools.

CAPEX (Capital Expenditure):
  Assets with >1 year useful life. Rare on cards.
  Hardware purchases, major software implementations, leasehold improvements.

PREPAID:
  Annual subscriptions charged upfront that should be amortized monthly.
  Flag these for the accountant to set up a prepaid schedule.

AMBIGUOUS CHARGES THAT ALWAYS NEED A QUESTION:
  - AWS/GCP/Azure: prod vs dev? (COGS vs RD)
  - Figma/design tools: product design (RD) vs marketing design (SM)?
  - Zoom/conferencing: customer calls (COGS) vs internal (GA)?
  - Contractor payments: what did they build?
  - Any annual charge over $1,000: could be PREPAID

OUTPUT FORMAT (JSON only, no markdown):
{
  "glBucket": "COGS" | "RD" | "SM" | "GA" | "CAPEX" | "PREPAID" | "UNKNOWN",
  "confidence": 0.0-1.0,
  "isAmbiguous": boolean,
  "clarificationQuestion": string | null,
  "reasoning": string,
  "isPrepaid": boolean,
  "amortizationMonths": number | null
}`;

// ── classifyTransaction() ───────────────────────────────────────────────

export async function classifyTransaction(
  tx: TransactionContext,
  client: Anthropic,
  kb: KnowledgeBase,
  glCodes?: GLCodeMap
): Promise<GLClassification> {
  const userMessage = [
    `Vendor: ${tx.vendor}`,
    `Amount: $${tx.amount}`,
    `Category (from card platform): ${tx.category}`,
    `Cardholder: ${tx.cardholderName}`,
    `Memo: ${tx.memoEntered ?? '(none)'}`,
    `Date: ${tx.transactionDate}`,
    ``,
    `Company context from knowledge base:`,
    kb.businessContext || '(not configured)',
    ``,
    `Cardholder role context:`,
    (() => {
      const { matchEmployee } = require('./knowledge-base.js');
      const emp = matchEmployee(tx.cardholderName, kb);
      return emp
        ? `${emp.role} on ${emp.team} team. Typical spend: ${emp.typicalSpend.join(', ')}`
        : '(no role context in knowledge base)';
    })(),
  ].join('\n');

  try {
    const message = await client.messages.create({
      model: process.env.COMP_CONTROL_ENRICH_MODEL ?? 'claude-sonnet-4-5',
      max_tokens: 512,
      system: COGS_CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw =
      message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());

    const glBucket: GLBucket = parsed.glBucket ?? 'UNKNOWN';
    const glCode = glCodes?.[glBucket] ?? null;

    const glAccountNames: Record<GLBucket, string> = {
      COGS: 'Cost of Revenue',
      RD: 'Research & Development',
      SM: 'Sales & Marketing',
      GA: 'General & Administrative',
      CAPEX: 'Capital Expenditure',
      PREPAID: 'Prepaid Expense',
      INTERCOMPANY: 'Intercompany',
      UNKNOWN: 'Unclassified',
    };

    log.info(`[COGS] ${tx.vendor} $${tx.amount} → ${glBucket} (${Math.round(parsed.confidence * 100)}% confidence)`);

    return {
      transactionId: tx.transactionId,
      vendor: tx.vendor,
      amount: tx.amount,
      glBucket,
      glCode,
      glAccountName: glAccountNames[glBucket],
      confidence: parsed.confidence,
      isAmbiguous: parsed.isAmbiguous,
      clarificationQuestion: parsed.clarificationQuestion,
      reasoning: parsed.reasoning,
      isPrepaid: parsed.isPrepaid,
      amortizationMonths: parsed.amortizationMonths,
      classifiedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[COGS] Classification failed for ${tx.vendor}: ${msg}`);
    return {
      transactionId: tx.transactionId,
      vendor: tx.vendor,
      amount: tx.amount,
      glBucket: 'UNKNOWN',
      glCode: null,
      glAccountName: 'Unclassified',
      confidence: 0,
      isAmbiguous: true,
      clarificationQuestion: `Can you describe the business purpose of this $${tx.amount} charge at ${tx.vendor}? We need this to assign the correct GL code.`,
      reasoning: `Classification failed: ${msg}`,
      isPrepaid: false,
      amortizationMonths: null,
      classifiedAt: new Date().toISOString(),
    };
  }
}
