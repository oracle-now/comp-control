/**
 * workflows/generic-workflow.ts
 * Template for any SaaS expense platform.
 *
 * Override targetUrl and credentials for your platform.
 * The agent will use observe() to understand the page structure
 * and act() / extract() to operate on it.
 *
 * Works with:
 *   - Expensify
 *   - Concur
 *   - Navan (TripActions)
 *   - Brex
 *   - Any custom expense tool with a login + approval queue
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import { runAccountantAgent } from '../agents/accountant.agent.js';

export async function runGenericWorkflow(
  stagehand: Stagehand,
  config: {
    targetUrl: string;
    credentials: { email: string; password: string };
    dryRun?: boolean;
  }
) {
  return runAccountantAgent(stagehand, {
    dryRun: config.dryRun ?? false,
    targetUrl: config.targetUrl,
    credentials: config.credentials,
  });
}
