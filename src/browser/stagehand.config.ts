/**
 * browser/stagehand.config.ts
 * Stagehand session factory — local (Playwright-backed) or cloud (Browserbase).
 *
 * NOTE: "local mode" still uses Playwright under the hood — that's Stagehand's
 * own internal dependency. We never import or call Playwright directly.
 * The only browser API we use is the Stagehand interface: act/extract/observe/agent.
 *
 * Local mode:  Free. Stagehand spins up a headless Chromium via its own Playwright dep.
 * Cloud mode:  Browserbase. CAPTCHA handling, proxies, persistent sessions.
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { ConstructorParams } from '@browserbasehq/stagehand';

export type RunMode = 'local' | 'cloud';

export interface StagehandSessionConfig {
  mode: RunMode;
  headless?: boolean;
  verbose?: boolean;
}

export async function createStagehandSession(
  config: StagehandSessionConfig
): Promise<Stagehand> {
  const isCloud = config.mode === 'cloud';

  if (isCloud) {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;

    if (!apiKey || !projectId) {
      throw new Error(
        'Cloud mode requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID in .env'
      );
    }
  }

  const params: ConstructorParams = {
    env: isCloud ? 'BROWSERBASE' : 'LOCAL',
    apiKey: isCloud ? process.env.BROWSERBASE_API_KEY : undefined,
    projectId: isCloud ? process.env.BROWSERBASE_PROJECT_ID : undefined,
    headless: config.headless ?? true,
    verbose: config.verbose ? 1 : 0,
    modelName: 'claude-sonnet-4-5',
    modelClientOptions: {
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    // Selector caching: after first run on a page layout, LLM calls are
    // skipped for cached selectors. ~80% cost reduction on repeat workflows.
    enableCaching: true,
    domSettleTimeoutMs: 3000,
  };

  const stagehand = new Stagehand(params);
  await stagehand.init();

  console.log(`[stagehand] Session initialized — ${config.mode.toUpperCase()} mode`);
  return stagehand;
}
