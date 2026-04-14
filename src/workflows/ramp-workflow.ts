/**
 * workflows/ramp-workflow.ts
 *
 * Ramp-specific workflow orchestrator.
 * Wraps runAccountantAgent() with:
 *   - credential resolution from env
 *   - inline escalation Slack alerts during the approval loop
 *   - final Slack digest post
 *
 * Called by the scheduler in index.ts for the Ramp platform.
 * The generic workflow path in index.ts remains unchanged.
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import { runAccountantAgent } from '../agents/accountant.agent.js';
import type { RunSummary } from '../agents/accountant.agent.js';
import { postAPDigest, postEscalationAlert } from '../notifications/slack.js';
import { loadPolicy } from '../policy/rules.js';
import { log } from '../utils/logger.js';

export interface RampWorkflowOptions {
  dryRun?: boolean;
  skipSlack?: boolean;
  skipJudgement?: boolean;
}

export async function runRampWorkflow(
  stagehand: Stagehand,
  options: RampWorkflowOptions = {}
): Promise<RunSummary> {
  const targetUrl = process.env.TARGET_URL ?? 'https://app.ramp.com';
  const email = process.env.RAMP_EMAIL ?? process.env.TARGET_EMAIL ?? '';
  const password = process.env.RAMP_PASSWORD ?? process.env.TARGET_PASSWORD ?? '';
  const policy = loadPolicy();

  if (!email || !password) {
    throw new Error(
      'RAMP_EMAIL and RAMP_PASSWORD (or TARGET_EMAIL/TARGET_PASSWORD) must be set'
    );
  }

  log.info('[RampWorkflow] Starting Ramp AP approval run');

  const summary = await runAccountantAgent(stagehand, {
    targetUrl,
    credentials: { email, password },
    dryRun: options.dryRun ?? false,
    skipJudgement: options.skipJudgement ?? false,
  });

  // ── Inline escalation alerts ─────────────────────────────────────────
  // Post an immediate Slack alert for each flagged item that exceeds the
  // escalation threshold — don't wait for the end-of-run digest.
  if (!options.skipSlack) {
    for (const item of summary.flaggedItems) {
      if (item.amount >= policy.escalation.total_flagged_spend_threshold) {
        await postEscalationAlert(item, item.flagReason);
      }
    }
  }

  // ── End-of-run digest ────────────────────────────────────────────────
  if (!options.skipSlack) {
    await postAPDigest({
      summary,
      judgement: summary.judgement,
      targetUrl,
      runDate: new Date(),
    });
  }

  // Surface CAPTCHA and failure verdicts as log-level signals
  // (already logged inside judgeRun, but repeat here for the workflow layer)
  if (summary.judgement?.reachedCaptcha) {
    log.warn('[RampWorkflow] CAPTCHA flag in judgement — check session health');
  }

  log.info('[RampWorkflow] Run complete', {
    approved: summary.totalApproved,
    flagged: summary.totalFlagged,
    verdict: summary.judgement?.verdict ?? 'not judged',
  });

  return summary;
}
