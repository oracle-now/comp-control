/**
 * src/index.ts — CLI entrypoint
 *
 * Usage:
 *   npm run review                  # Run with defaults from .env
 *   npm run review -- --dry-run     # No browser actions taken
 *   npm run review -- --mode cloud  # Use Browserbase
 *   npm run review -- --mode local  # Use local Playwright
 */

import 'dotenv/config';
import { createStagehandSession, type RunMode } from './browser/stagehand.config.js';
import { runRampApprovals } from './workflows/ramp-approvals.js';
import { runGenericWorkflow } from './workflows/generic-workflow.js';
import { log } from './utils/logger.js';

// ── CLI arg parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const mode = (args.find(a => a.startsWith('--mode='))?.split('=')[1] ??
  (args[args.indexOf('--mode') + 1]) ??
  process.env.RUN_MODE ??
  'local') as RunMode;

const targetUrl = process.env.TARGET_URL ?? '';

if (!targetUrl) {
  log.error('TARGET_URL is not set in .env');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  log.error('ANTHROPIC_API_KEY is not set in .env');
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  log.info(`comp-control starting`, { mode, dryRun, targetUrl });

  const stagehand = await createStagehandSession({
    mode,
    headless: !dryRun, // Show browser window in dry-run for visibility
    verbose: process.env.LOG_LEVEL === 'debug',
  });

  let summary;

  try {
    // Route to the appropriate workflow based on the target URL
    if (targetUrl.includes('ramp.com')) {
      summary = await runRampApprovals(stagehand, { dryRun });
    } else {
      const email = process.env.TARGET_EMAIL ?? '';
      const password = process.env.TARGET_PASSWORD ?? '';
      summary = await runGenericWorkflow(stagehand, {
        targetUrl,
        credentials: { email, password },
        dryRun,
      });
    }
  } finally {
    await stagehand.close();
  }

  // ── Print run summary ───────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  comp-control Run Summary');
  console.log('═'.repeat(60));
  console.log(`  Total reviewed : ${summary.totalReviewed}`);
  console.log(`  Auto-approved  : ${summary.totalApproved}`);
  console.log(`  Flagged        : ${summary.totalFlagged}`);
  console.log(`  Errors         : ${summary.errors.length}`);
  console.log(`  Duration       : ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (summary.flaggedItems.length > 0) {
    console.log('\n  Flagged Items:');
    for (const item of summary.flaggedItems) {
      console.log(`    • ${item.vendor} $${item.amount} — ${item.flagReason}`);
    }
    console.log('\n  Review flagged items at: http://localhost:3001');
  }
  console.log('═'.repeat(60) + '\n');

  if (summary.errors.length > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  log.error('Fatal error', err);
  process.exit(1);
});
