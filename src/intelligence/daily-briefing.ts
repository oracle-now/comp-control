/**
 * intelligence/daily-briefing.ts
 *
 * The AP Second Brain — morning briefing that tells you everything
 * your manager expects you to already know.
 *
 * An AP specialist with ADHD (or any AP specialist, honestly) shouldn't
 * have to hold all this in their head:
 *   - What needs action TODAY (aging, month-end proximity, open questions)
 *   - What's been sitting unresolved and for how long
 *   - What's coming up this week (payment due dates, close deadlines)
 *   - What changed since yesterday
 *   - What to say if your manager asks "where are we on AP?"
 *
 * This module assembles all intelligence signals into one structured
 * briefing, formatted for:
 *   1. A Slack message you wake up to (sent to your personal DM)
 *   2. An internal memo for your own working memory
 *   3. A one-paragraph "status if asked" summary
 *
 * The goal: you open Slack at 8:45am and by 9:00am you know exactly
 * what to work on today, in priority order, with context.
 */

import type { DuplicateReport } from './duplicate-detector.js';
import type { GLClassification } from './cogs-classifier.js';
import type { EnrichmentResult } from '../enrichment/enrich-transaction.js';
import type { TransactionContext } from '../enrichment/enrich-transaction.js';

// ── Types ──────────────────────────────────────────────────────────────

export type ActionPriority = 'urgent' | 'today' | 'this-week' | 'monitor';

export interface ActionItem {
  priority: ActionPriority;
  category: string;   // e.g. "Duplicate", "COGS Ambiguity", "Aging", "New Vendor"
  title: string;      // one-line summary
  detail: string;     // what exactly needs to happen
  dueBy?: string;     // ISO date if time-sensitive
  amount?: number;
  cardholderName?: string;
  transactionId?: string;
}

export interface APBriefing {
  /** Date this briefing covers */
  date: string;

  /** Ordered action items — the "what to work on today" list */
  actionItems: ActionItem[];

  /** Counts by priority for the headline */
  counts: {
    urgent: number;
    today: number;
    thisWeek: number;
    monitor: number;
    totalOpenAmount: number;
  };

  /**
   * The one-paragraph "status if asked" summary.
   * If your manager walks over and asks "where are we on AP?"
   * you read this and sound completely on top of it.
   */
  statusSummary: string;

  /**
   * Things to watch but not act on yet.
   * Contracts coming up for renewal, vendors with increasing spend
   * trends, cardholders with multiple open questions.
   */
  watchItems: string[];

  /** Formatted Slack Block Kit message ready to post */
  slackMessage: object;

  generatedAt: string;
}

// ── Briefing assembler ──────────────────────────────────────────────────────

export function assembleBriefing(params: {
  transactions: TransactionContext[];
  enrichmentResults: EnrichmentResult[];
  glClassifications: GLClassification[];
  duplicateReport: DuplicateReport;
  newVendorCount: number;
  dayOfMonth: number;
  monthEndCloseDays: number[];  // from policy
}): APBriefing {
  const {
    transactions,
    enrichmentResults,
    glClassifications,
    duplicateReport,
    newVendorCount,
    dayOfMonth,
    monthEndCloseDays,
  } = params;

  const actionItems: ActionItem[] = [];
  const watchItems: string[] = [];
  const today = new Date().toISOString().split('T')[0]!;
  const isCloseWindow = monthEndCloseDays.includes(dayOfMonth);

  // ── Priority 1: Duplicates (urgent — money at risk) ───────────────────────
  for (const dup of duplicateReport.flagged) {
    actionItems.push({
      priority: 'urgent',
      category: 'Duplicate Charge',
      title: `${dup.type === 'double_billing' ? '💳 Possible double bill' : dup.type === 'double_expensing' ? '👥 Double expensed' : '⚠️ Split transaction'} — ${dup.vendor} $${dup.amount}`,
      detail: `${dup.explanation} ${dup.recommendedAction}`,
      amount: dup.amount,
      transactionId: dup.transactionId,
    });
  }

  // ── Priority 2: Escalations ───────────────────────────────────────────────
  const escalations = enrichmentResults.filter(r => r.verdict === 'escalate');
  for (const esc of escalations) {
    const tx = transactions.find(t => t.transactionId === esc.transactionId);
    actionItems.push({
      priority: 'urgent',
      category: 'Escalation',
      title: `🚨 Escalated — ${tx?.vendor ?? 'Unknown'} $${tx?.amount ?? '?'} by ${tx?.cardholderName ?? '?'}`,
      detail: esc.accountantReasoning,
      amount: tx?.amount,
      cardholderName: tx?.cardholderName,
      transactionId: esc.transactionId,
    });
  }

  // ── Priority 3: Ambiguous GL codes (today, before books close) ─────────
  const ambiguousGL = glClassifications.filter(g => g.isAmbiguous);
  for (const gl of ambiguousGL) {
    const tx = transactions.find(t => t.transactionId === gl.transactionId);
    actionItems.push({
      priority: isCloseWindow ? 'urgent' : 'today',
      category: 'GL Coding',
      title: `📊 GL ambiguous — ${gl.vendor} $${gl.amount} (${gl.glBucket}?)`,
      detail: gl.clarificationQuestion ?? `Confirm GL code for ${gl.vendor} charge.`,
      amount: gl.amount,
      cardholderName: tx?.cardholderName,
      transactionId: gl.transactionId,
    });
  }

  // ── Priority 4: Open cardholder questions ────────────────────────────
  const openQuestions = enrichmentResults.filter(
    r => r.verdict === 'question' && r.cardholderQuestion
  );
  for (const q of openQuestions) {
    const tx = transactions.find(t => t.transactionId === q.transactionId);
    actionItems.push({
      priority: 'today',
      category: 'Cardholder Question',
      title: `❓ Awaiting response — ${tx?.vendor ?? '?'} $${tx?.amount ?? '?'} from ${tx?.cardholderName ?? '?'}`,
      detail: q.cardholderQuestion ?? '',
      amount: tx?.amount,
      cardholderName: tx?.cardholderName,
      transactionId: q.transactionId,
    });
  }

  // ── Priority 5: New vendors needing review ───────────────────────────
  if (newVendorCount > 0) {
    actionItems.push({
      priority: 'today',
      category: 'New Vendor',
      title: `🔍 ${newVendorCount} new vendor${newVendorCount > 1 ? 's' : ''} detected and auto-researched`,
      detail: 'Review vendor profiles in data/vendor-cache.json. Add pre-cleared vendors to knowledge.yaml.',
    });
  }

  // ── Month-end close window alerts ─────────────────────────────────
  if (isCloseWindow) {
    const uncodedCount = glClassifications.filter(g => g.glBucket === 'UNKNOWN').length;
    if (uncodedCount > 0) {
      actionItems.push({
        priority: 'urgent',
        category: 'Month-End Close',
        title: `🗓️ CLOSE WINDOW: ${uncodedCount} transactions still unclassified`,
        detail: `Books close soon. These need GL codes before period end.`,
        dueBy: today,
      });
    }

    const prepaidItems = glClassifications.filter(g => g.isPrepaid);
    if (prepaidItems.length > 0) {
      const prepaidTotal = prepaidItems.reduce((s, g) => s + g.amount, 0);
      actionItems.push({
        priority: 'today',
        category: 'Prepaid Schedule',
        title: `🗓️ ${prepaidItems.length} annual charges need prepaid amortization setup`,
        detail: `Total: $${prepaidTotal}. Set up prepaid schedules before close.`,
        amount: prepaidTotal,
      });
    }
  }

  // ── Watch items ────────────────────────────────────────────────────────────

  // Cardholders with multiple open items
  const cardholderQuestionCounts = new Map<string, number>();
  for (const q of openQuestions) {
    const tx = transactions.find(t => t.transactionId === q.transactionId);
    if (tx) {
      cardholderQuestionCounts.set(
        tx.cardholderName,
        (cardholderQuestionCounts.get(tx.cardholderName) ?? 0) + 1
      );
    }
  }
  for (const [name, count] of cardholderQuestionCounts) {
    if (count >= 3) {
      watchItems.push(
        `${name} has ${count} open questions — may need a direct conversation rather than more comments`
      );
    }
  }

  if (isCloseWindow) {
    watchItems.push(`🗓️ You are in the month-end close window (day ${dayOfMonth}). Prioritize GL coding and receipt collection.`);
  }

  // ── Sort by priority ───────────────────────────────────────────────────────
  const priorityOrder: Record<ActionPriority, number> = {
    urgent: 0, today: 1, 'this-week': 2, monitor: 3,
  };
  actionItems.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // ── Counts ──────────────────────────────────────────────────────────────
  const counts = {
    urgent: actionItems.filter(i => i.priority === 'urgent').length,
    today: actionItems.filter(i => i.priority === 'today').length,
    thisWeek: actionItems.filter(i => i.priority === 'this-week').length,
    monitor: actionItems.filter(i => i.priority === 'monitor').length,
    totalOpenAmount: actionItems.reduce((s, i) => s + (i.amount ?? 0), 0),
  };

  // ── Status summary ────────────────────────────────────────────────────────
  const urgentLine = counts.urgent > 0
    ? `${counts.urgent} urgent item${counts.urgent > 1 ? 's' : ''} need immediate attention`
    : 'No urgent items';
  const dupLine = duplicateReport.summary.doubleBilling + duplicateReport.summary.doubleExpensing > 0
    ? `, ${duplicateReport.summary.doubleBilling + duplicateReport.summary.doubleExpensing} potential duplicate charge${duplicateReport.summary.doubleBilling + duplicateReport.summary.doubleExpensing > 1 ? 's' : ''} totaling ~$${duplicateReport.summary.estimatedDuplicateSpend}`
    : '';
  const closeNote = isCloseWindow ? ' We are in the month-end close window.' : '';
  const glNote = ambiguousGL.length > 0
    ? ` ${ambiguousGL.length} transaction${ambiguousGL.length > 1 ? 's' : ''} need GL classification confirmation before books close.`
    : '';

  const statusSummary =
    `${urgentLine}${dupLine}. ${openQuestions.length} cardholder question${openQuestions.length !== 1 ? 's' : ''} are pending response.` +
    glNote + closeNote +
    ` Total open AP activity: ${transactions.length} transactions, ~$${counts.totalOpenAmount.toLocaleString()}.`;

  // ── Slack Block Kit message ───────────────────────────────────────────────
  const urgentBlocks = actionItems
    .filter(i => i.priority === 'urgent')
    .slice(0, 5)
    .map(item => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${item.title}*\n${item.detail.slice(0, 200)}` },
    }));

  const todayBlocks = actionItems
    .filter(i => i.priority === 'today')
    .slice(0, 5)
    .map(item => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `${item.title}` },
    }));

  const slackMessage = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🧠 AP Briefing — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*🚨 Urgent*\n${counts.urgent}` },
          { type: 'mrkdwn', text: `*📌 Today*\n${counts.today}` },
          { type: 'mrkdwn', text: `*❓ Open Questions*\n${openQuestions.length}` },
          { type: 'mrkdwn', text: `*💰 At Risk*\n$${duplicateReport.summary.estimatedDuplicateSpend.toLocaleString()}` },
        ],
      },
      { type: 'divider' },
      ...(urgentBlocks.length > 0
        ? [
            { type: 'section', text: { type: 'mrkdwn', text: '*Urgent — needs action now:*' } },
            ...urgentBlocks,
            { type: 'divider' },
          ]
        : []),
      ...(todayBlocks.length > 0
        ? [
            { type: 'section', text: { type: 'mrkdwn', text: '*Today:*' } },
            ...todayBlocks,
          ]
        : []),
      ...(watchItems.length > 0
        ? [
            { type: 'divider' },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*👁 Watch:*\n${watchItems.map(w => `• ${w}`).join('\n')}`,
              },
            },
          ]
        : []),
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `_Status if asked: "${statusSummary}"_` },
        ],
      },
    ],
  };

  return {
    date: today,
    actionItems,
    counts,
    statusSummary,
    watchItems,
    slackMessage,
    generatedAt: new Date().toISOString(),
  };
}
