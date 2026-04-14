/**
 * src/index.ts — scheduler + CLI entrypoint
 *
 * Two modes:
 *
 *   SCHEDULER MODE (default, used in Railway):
 *     node dist/index.js
 *     Registers a weekday 9am cron job and keeps the process alive.
 *     Full pipeline: Ramp approvals → Slack digest → email triage.
 *
 *   ONE-SHOT MODE (CI, manual trigger, dry-run):
 *     node dist/index.js --once [--dry-run] [--mode=local|cloud]
 *     Runs immediately and exits. Same pipeline as scheduler.
 *
 * Environment variables:
 *   CRON_SCHEDULE     Override the default cron expression (default: '0 9 * * 1-5')
 *   CRON_TIMEZONE     Timezone for the cron (default: 'America/Los_Angeles')
 *   EMAIL_TRIAGE      Set to 'true' to enable email inbox triage after Ramp run
 *   SKIP_SLACK        Set to 'true' to suppress all Slack notifications
 *   RUN_MODE          'local' | 'cloud' (Browserbase). Default: 'local'
 *   DRY_RUN           'true' to skip all browser actions
 */

import 'dotenv/config';
import cron from 'node-cron';
import { createStagehandSession, type RunMode } from './browser/stagehand.config.js';
import { runRampWorkflow } from './workflows/ramp-workflow.js';
import { runGenericWorkflow } from './workflows/generic-workflow.js';
import { triageAPInbox, formatEmailDigest } from './notifications/email.js';
import { postAgentError } from './notifications/slack.js';
import { log } from './utils/logger.js';

// ── Config ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const oneShot = args.includes('--once') || args.includes('--dry-run');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const mode = (
  args.find(a => a.startsWith('--mode='))?.split('=')[1] ??
  args[args.indexOf('--mode') + 1] ??
  process.env.RUN_MODE ??
  'local'
) as RunMode;

const targetUrl = process.env.TARGET_URL ?? 'https://app.ramp.com';
const emailTriageEnabled = process.env.EMAIL_TRIAGE === 'true';
const skipSlack = process.env.SKIP_SLACK === 'true';

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 9 * * 1-5';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? 'America/Los_Angeles';

// ── Validation ───────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  log.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

// ── Pipeline ─────────────────────────────────────────────────────────────

/**
 * Full run pipeline. Runs once per invocation.
 * The scheduler calls this on its cron; --once calls it directly.
 */
async function runPipeline(): Promise<void> {
  log.info('comp-control pipeline starting', { mode, dryRun, targetUrl });

  const stagehand = await createStagehandSession({
    mode,
    headless: !dryRun,
    verbose: process.env.LOG_LEVEL === 'debug',
  });

  let summary;

  try {
    // ── Step 1: Ramp (or generic) approvals ─────────────────────────────
    if (targetUrl.includes('ramp.com')) {
      summary = await runRampWorkflow(stagehand, { dryRun, skipSlack });
    } else {
      const email = process.env.TARGET_EMAIL ?? '';
      const password = process.env.TARGET_PASSWORD ?? '';
      summary = await runGenericWorkflow(stagehand, {
        targetUrl,
        credentials: { email, password },
        dryRun,
      });
    }

    // ── Step 2: Email inbox triage (optional) ───────────────────────────
    if (emailTriageEnabled) {
      log.info('Email triage enabled — triaging AP inbox...');
      const emailResult = await triageAPInbox(stagehand);
      const digest = formatEmailDigest(emailResult);
      log.info('[EmailTriage] ' + digest.split('\n')[0]); // log first line
    }

  } finally {
    await stagehand.close();
  }

  // ── Print run summary ────────────────────────────────────────────────
  const ruler = '═'.repeat(60);
  console.log(`\n${ruler}`);
  console.log('  comp-control Run Summary');
  console.log(ruler);
  console.log(`  Total reviewed : ${summary.totalReviewed}`);
  console.log(`  Auto-approved  : ${summary.totalApproved}`);
  console.log(`  Flagged        : ${summary.totalFlagged}`);
  console.log(`  Errors         : ${summary.errors.length}`);
  console.log(`  Duration       : ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Prompt mode    : ${summary.promptMode}`);

  if (summary.judgement) {
    const j = summary.judgement;
    console.log(`  Verdict        : ${j.verdict.toUpperCase()}${j.failureReason ? ` — ${j.failureReason}` : ''}`);
    if (j.reachedCaptcha) console.log('  ⚠️  CAPTCHA detected during run');
  }

  if (summary.flaggedItems.length > 0) {
    console.log('\n  Flagged Items:');
    for (const item of summary.flaggedItems) {
      console.log(`    • ${item.vendor} $${item.amount} — ${item.flagReason}`);
    }
    console.log('\n  Review at: ' + (process.env.REVIEW_DASHBOARD_URL ?? 'http://localhost:3001'));
  }

  console.log(`${ruler}\n`);

  if (summary.errors.length > 0) {
    throw new Error(`Run completed with ${summary.errors.length} error(s)`);
  }
}

// ── Entry points ─────────────────────────────────────────────────────────

async function runOnce(): Promise<void> {
  try {
    await runPipeline();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Pipeline failed', { err: msg });
    if (!skipSlack) await postAgentError(msg, targetUrl);
    process.exit(1);
  }
}

function startScheduler(): void {
  if (!cron.validate(CRON_SCHEDULE)) {
    log.error(`Invalid CRON_SCHEDULE: "${CRON_SCHEDULE}"`);
    process.exit(1);
  }

  log.info(`comp-control scheduler started`, {
    schedule: CRON_SCHEDULE,
    timezone: CRON_TIMEZONE,
    emailTriage: emailTriageEnabled,
    slackEnabled: !skipSlack,
  });

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      log.info('🤖 Scheduled AP run starting...');
      try {
        await runPipeline();
        log.info('✅ Scheduled AP run complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('❌ Scheduled AP run failed', { err: msg });
        if (!skipSlack) await postAgentError(msg, targetUrl);
        // Do NOT process.exit() in scheduler mode — keep the process alive
        // for the next scheduled run. Log the error and move on.
      }
    },
    {
      timezone: CRON_TIMEZONE,
    }
  );

  console.log(`AP Agent scheduler running. Next run: weekdays at 9am ${CRON_TIMEZONE}.`);
  console.log('Use --once to trigger an immediate run.');
}

// ── Boot ─────────────────────────────────────────────────────────────────

if (oneShot) {
  void runOnce();
} else {
  startScheduler();
}
