/**
 * notifications/slack.ts
 *
 * AP digest and alert notifications via Slack Web API.
 * Uses @slack/web-api directly — no browser, no Stagehand.
 *
 * Three message types:
 *   postAPDigest()        — end-of-run summary (approved / flagged / escalated)
 *   postEscalationAlert() — immediate alert when a single item exceeds escalation threshold
 *   postAgentError()      — pings the channel when the agent crashes entirely
 *
 * All functions are no-ops when SLACK_TOKEN is not set (local dev without Slack).
 * Set SLACK_ENABLED=false to suppress even when the token is present.
 */

import { WebClient } from '@slack/web-api';
import type { RunSummary } from '../agents/accountant.agent.js';
import type { JudgementResult } from '../memory/judge-run.js';
import type { ReviewItem } from '../workflows/review-queue.js';
import { log } from '../utils/logger.js';

// ── Client ───────────────────────────────────────────────────────────────

function getClient(): WebClient | null {
  if (process.env.SLACK_ENABLED === 'false') return null;
  const token = process.env.SLACK_TOKEN;
  if (!token) {
    log.debug('[Slack] SLACK_TOKEN not set — notifications disabled');
    return null;
  }
  return new WebClient(token);
}

function channelId(): string {
  return process.env.SLACK_CHANNEL_ID ?? '';
}

// ── Types ────────────────────────────────────────────────────────────────

export interface DigestPayload {
  summary: RunSummary;
  judgement: JudgementResult | null;
  targetUrl: string;
  runDate: Date;
}

// ── Formatters ───────────────────────────────────────────────────────────

function verdictEmoji(judgement: JudgementResult | null): string {
  if (!judgement) return '❓';
  if (judgement.verdict === 'success') return '✅';
  if (judgement.verdict === 'partial') return '⚠️';
  return '❌';
}

function formatFlaggedList(items: ReviewItem[]): string {
  if (items.length === 0) return '_None_';
  return items
    .slice(0, 10) // cap at 10 lines to avoid Slack message length limits
    .map(i => `  • *${i.vendor}* $${i.amount.toFixed(2)} — ${i.flagReason}`)
    .join('\n')
    .concat(items.length > 10 ? `\n  …and ${items.length - 10} more` : '');
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Post the end-of-run AP digest to Slack.
 * This is the primary notification — one message per run, contains
 * everything a human reviewer needs to action flagged items.
 */
export async function postAPDigest(payload: DigestPayload): Promise<void> {
  const client = getClient();
  if (!client || !channelId()) return;

  const { summary, judgement, targetUrl, runDate } = payload;
  const dateStr = runDate.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });

  const verdict = verdictEmoji(judgement);
  const captchaWarning = judgement?.reachedCaptcha
    ? '\n\n:warning: *CAPTCHA detected* — session may need rotation'
    : '';
  const failureNote = judgement?.failureReason
    ? `\n:x: *Run issue:* ${judgement.failureReason}`
    : '';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${verdict} AP Daily Digest — ${dateStr}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*✅ Auto-approved*\n${summary.totalApproved}` },
        { type: 'mrkdwn', text: `*⚠️ Flagged for review*\n${summary.totalFlagged}` },
        { type: 'mrkdwn', text: `*📄 Total reviewed*\n${summary.totalReviewed}` },
        { type: 'mrkdwn', text: `*⏱ Duration*\n${formatDuration(summary.durationMs)}` },
      ],
    },
    ...(summary.flaggedItems.length > 0
      ? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Flagged items:*\n${formatFlaggedList(summary.flaggedItems)}`,
            },
          },
        ]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            `Prompt mode: \`${summary.promptMode}\``,
            `Target: ${targetUrl}`,
            captchaWarning,
            failureNote,
          ]
            .filter(Boolean)
            .join('  |  '),
        },
      ],
    },
    ...(summary.flaggedItems.length > 0
      ? [
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '👀 Review Flagged Items', emoji: true },
                url: process.env.REVIEW_DASHBOARD_URL ?? 'http://localhost:3001',
                style: 'primary',
              },
            ],
          },
        ]
      : []),
  ];

  try {
    await client.chat.postMessage({
      channel: channelId(),
      text: `AP Digest ${dateStr}: ${summary.totalApproved} approved, ${summary.totalFlagged} flagged`,
      blocks,
    });
    log.info('[Slack] AP digest posted');
  } catch (err) {
    log.error('[Slack] Failed to post digest', { err });
  }
}

/**
 * Immediate escalation alert for a single high-value item.
 * Called inline during the approval loop when an item hits the escalation threshold.
 * Does NOT wait for end-of-run.
 */
export async function postEscalationAlert(item: ReviewItem, reason: string): Promise<void> {
  const client = getClient();
  if (!client || !channelId()) return;

  try {
    await client.chat.postMessage({
      channel: channelId(),
      text: `:rotating_light: *Escalation: ${item.vendor} $${item.amount.toFixed(2)}* — ${reason}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:rotating_light: *Escalation required*\n*Vendor:* ${item.vendor}\n*Amount:* $${item.amount.toFixed(2)}\n*Category:* ${item.category}\n*Reason:* ${reason}\n*Receipt:* ${item.hasReceipt ? 'Yes' : ':warning: Missing'}`,
          },
        },
      ],
    });
    log.info(`[Slack] Escalation alert posted for ${item.vendor} $${item.amount}`);
  } catch (err) {
    log.error('[Slack] Failed to post escalation alert', { err });
  }
}

/**
 * Agent crash alert. Called from the scheduler catch block.
 * Gives just enough info to diagnose without a full log dump.
 */
export async function postAgentError(errorMessage: string, targetUrl: string): Promise<void> {
  const client = getClient();
  if (!client || !channelId()) return;

  try {
    await client.chat.postMessage({
      channel: channelId(),
      text: `:x: *AP Agent failed* — ${new Date().toLocaleString()}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:x: *AP Agent crashed*\n\`\`\`${errorMessage.slice(0, 500)}\`\`\`\n*Target:* ${targetUrl}\n*Time:* ${new Date().toISOString()}`,
          },
        },
      ],
    });
  } catch (err) {
    log.error('[Slack] Failed to post agent error alert', { err });
  }
}
