/**
 * workflows/ramp-approvals.ts
 * Ramp.com-specific workflow wrapper.
 *
 * Ramp has a consistent UI with a dedicated Approvals queue.
 * This workflow navigates directly to it, improving reliability
 * vs. generic navigation.
 *
 * Usage:
 *   import { runRampApprovals } from './ramp-approvals.js';
 *   await runRampApprovals(stagehand, { dryRun: false });
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import { runAccountantAgent } from '../agents/accountant.agent.js';

const RAMP_BASE_URL = 'https://app.ramp.com';
const RAMP_APPROVALS_PATH = '/approvals';

export async function runRampApprovals(
  stagehand: Stagehand,
  opts: { dryRun?: boolean } = {}
) {
  const email = process.env.TARGET_EMAIL;
  const password = process.env.TARGET_PASSWORD;

  if (!email || !password) {
    throw new Error('TARGET_EMAIL and TARGET_PASSWORD must be set in .env');
  }

  return runAccountantAgent(stagehand, {
    dryRun: opts.dryRun ?? false,
    targetUrl: `${RAMP_BASE_URL}${RAMP_APPROVALS_PATH}`,
    credentials: { email, password },
  });
}
