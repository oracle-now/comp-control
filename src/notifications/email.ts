/**
 * notifications/email.ts
 *
 * AP inbox triage agent using Stagehand.
 * Logs into Gmail or Outlook, reads unread AP-related emails,
 * classifies each one, and posts a digest to Slack.
 *
 * Read-only — no reply, no archive. Human follows up on flagged threads.
 *
 * Stagehand v3: extract() uses positional args — extract(instruction, schema)
 * Schema must be a Zod schema, NOT a raw JSON Schema object.
 */

import { z } from 'zod';
import type { Stagehand } from '@browserbasehq/stagehand';
import { log } from '../utils/logger.js';
import { postAPDigest } from './slack.js';

// ── Types ───────────────────────────────────────────────────────────────

export type EmailCategory = 'invoice' | 'receipt' | 'dispute' | 'query' | 'ignore';

export interface TriagedEmail {
  subject: string;
  from: string;
  receivedAt: string;
  category: EmailCategory;
  summary: string;
  amount?: number;
  suggestedAction: string;
}

export interface EmailTriageResult {
  totalScanned: number;
  actionable: TriagedEmail[];
  ignored: number;
  durationMs: number;
  errors: string[];
}

// ── Provider config ─────────────────────────────────────────────────────

const INBOX_URLS: Record<string, string> = {
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
  outlook: 'https://outlook.office.com/mail/inbox',
};

// ── Zod schema for email extraction ─────────────────────────────────────
// v3: extract() requires a Zod schema — raw JSON Schema objects are not accepted.

const emailsSchema = z.object({
  emails: z.array(z.object({
    subject: z.string(),
    from: z.string(),
    receivedAt: z.string(),
    bodySnippet: z.string(),
    mentionedAmount: z.number().optional(),
  })),
});

// ── Agent ────────────────────────────────────────────────────────────────

export async function triageAPInbox(
  stagehand: Stagehand
): Promise<EmailTriageResult> {
  const startTime = Date.now();
  const provider = (process.env.EMAIL_PROVIDER ?? 'gmail').toLowerCase();
  const inboxUrl = INBOX_URLS[provider] ?? INBOX_URLS['gmail'];

  const result: EmailTriageResult = {
    totalScanned: 0,
    actionable: [],
    ignored: 0,
    durationMs: 0,
    errors: [],
  };

  try {
    log.info(`[EmailAgent] Navigating to ${provider} inbox`);
    await stagehand.act(`Go to ${inboxUrl}`);
    await stagehand.observe('Confirm the inbox is loaded and unread emails are visible');

    log.info('[EmailAgent] Extracting unread AP-related emails...');

    // v3: positional args — extract(instruction, schema)
    // Schema must be Zod, not a raw JSON Schema object.
    const extracted = await stagehand.extract(
      [
        'Extract the 20 most recent unread emails.',
        'For each email, capture: subject line, sender name and email address,',
        'received timestamp, and a 1-2 sentence summary of the email body.',
        'Focus on emails related to: invoices, expense receipts, AP queries,',
        'vendor disputes, or payment notifications.',
        'Skip newsletters, marketing, and automated system notifications.',
      ].join(' '),
      emailsSchema,
    );

    result.totalScanned = extracted.emails.length;
    log.info(`[EmailAgent] Extracted ${extracted.emails.length} emails`);

    for (const email of extracted.emails) {
      const triaged = classifyEmail(email);
      if (triaged.category === 'ignore') {
        result.ignored++;
      } else {
        result.actionable.push(triaged);
      }
    }

    log.info(
      `[EmailAgent] Triage complete: ${result.actionable.length} actionable, ${result.ignored} ignored`
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    log.error(`[EmailAgent] Error: ${msg}`);
  } finally {
    result.durationMs = Date.now() - startTime;
  }

  return result;
}

// ── Classification ───────────────────────────────────────────────────────

function classifyEmail(email: {
  subject: string;
  from: string;
  receivedAt: string;
  bodySnippet: string;
  mentionedAmount?: number;
}): TriagedEmail {
  const text = `${email.subject} ${email.bodySnippet}`.toLowerCase();

  let category: EmailCategory = 'ignore';
  let suggestedAction = 'No action required';

  if (/invoice|bill|statement|due|payment request/i.test(text)) {
    category = 'invoice';
    suggestedAction = 'Process invoice in AP system';
  } else if (/receipt|confirmation|order confirmed|your purchase/i.test(text)) {
    category = 'receipt';
    suggestedAction = 'Match receipt to pending expense';
  } else if (/dispute|chargeback|unauthorized|fraud|reversal/i.test(text)) {
    category = 'dispute';
    suggestedAction = 'Escalate to finance team immediately';
  } else if (/expense|reimburs|claim|can you approve|question about/i.test(text)) {
    category = 'query';
    suggestedAction = 'Respond to employee query';
  }

  return {
    subject: email.subject,
    from: email.from,
    receivedAt: email.receivedAt,
    category,
    summary: email.bodySnippet,
    amount: email.mentionedAmount,
    suggestedAction,
  };
}

export function formatEmailDigest(result: EmailTriageResult): string {
  if (result.actionable.length === 0) {
    return ':incoming_envelope: *AP Inbox*: No actionable emails found';
  }

  const categoryEmoji: Record<EmailCategory, string> = {
    invoice: '💸',
    receipt: '🧾',
    dispute: '🚨',
    query: '❓',
    ignore: '⏩',
  };

  const lines = [
    `:incoming_envelope: *AP Inbox — ${result.actionable.length} actionable emails*`,
    ...result.actionable.slice(0, 8).map(e =>
      `  ${categoryEmoji[e.category]} *${e.category.toUpperCase()}* | ${e.from}\n    _${e.subject}_${e.amount ? ` ($${e.amount})` : ''}\n    → ${e.suggestedAction}`
    ),
    ...(result.actionable.length > 8
      ? [`  …and ${result.actionable.length - 8} more`]
      : []),
  ];

  return lines.join('\n');
}

export { postAPDigest };
