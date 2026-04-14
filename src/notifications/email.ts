/**
 * notifications/email.ts
 *
 * AP inbox triage agent using Stagehand.
 * Logs into Gmail or Outlook, reads unread AP-related emails,
 * classifies each one, and posts a digest to Slack.
 *
 * This is a secondary workflow that runs after the Ramp agent.
 * It does NOT take any actions on emails (no reply, no archive) —
 * read-only. Human follows up on flagged threads.
 *
 * Supported inboxes (set EMAIL_PROVIDER env var):
 *   gmail   — https://mail.google.com (default)
 *   outlook — https://outlook.office.com/mail
 *
 * Classification categories:
 *   invoice    — vendor invoice that needs processing
 *   receipt    — receipt for an already-approved expense
 *   dispute    — vendor dispute or chargeback notice
 *   query      — employee asking about an expense
 *   ignore     — newsletter, notification, or irrelevant
 */

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
  /** Dollar amount mentioned in the email, if any */
  amount?: number;
  /** Suggested action for a human reviewer */
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

// ── Agent ────────────────────────────────────────────────────────────────

/**
 * Triage the AP inbox.
 * Returns a structured result regardless of errors — partial results
 * are better than silence.
 */
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

    // Extract unread emails — limit to 20 most recent to cap token cost
    log.info('[EmailAgent] Extracting unread AP-related emails...');
    const extracted = await stagehand.extract({
      instruction: [
        'Extract the 20 most recent unread emails.',
        'For each email, capture: subject line, sender name and email address,',
        'received timestamp, and a 1-2 sentence summary of the email body.',
        'Focus on emails related to: invoices, expense receipts, AP queries,',
        'vendor disputes, or payment notifications.',
        'Skip newsletters, marketing, and automated system notifications.',
      ].join(' '),
      schema: {
        type: 'object',
        properties: {
          emails: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                from: { type: 'string' },
                receivedAt: { type: 'string' },
                bodySnippet: { type: 'string' },
                mentionedAmount: { type: 'number', description: 'Dollar amount if mentioned' },
              },
              required: ['subject', 'from', 'receivedAt', 'bodySnippet'],
            },
          },
        },
        required: ['emails'],
      },
    }) as {
      emails: Array<{
        subject: string;
        from: string;
        receivedAt: string;
        bodySnippet: string;
        mentionedAmount?: number;
      }>;
    };

    result.totalScanned = extracted.emails.length;
    log.info(`[EmailAgent] Extracted ${extracted.emails.length} emails`);

    // Classify each email
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

// ── Classification (heuristic, no extra LLM call) ────────────────────────
// Intentionally deterministic — keyword matching is free and fast.
// The extract() call already summarized the email; we just categorize.

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

/**
 * Format email triage results as a Slack mrkdwn string.
 * Appended to the AP digest when email triage is enabled.
 */
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

// Re-export postAPDigest for convenience in the scheduler
export { postAPDigest };
