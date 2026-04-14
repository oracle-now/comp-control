/**
 * browser/stagehand.config.ts
 * Stagehand initialization — supports both local (Playwright) and cloud (Browserbase) modes.
 *
 * Local mode:  Free. Runs headless Chromium on your machine.
 * Cloud mode:  Browserbase. Handles CAPTCHAs, proxies, session persistence.
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
    headless: config.headless ?? (isCloud ? true : false),
    verbose: config.verbose ? 1 : 0,
    modelName: 'claude-sonnet-4-5',
    modelClientOptions: {
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    // Enable selector caching — reduces LLM calls by ~80% on repeat page layouts
    enableCaching: true,
    domSettleTimeoutMs: 3000,
  };

  const stagehand = new Stagehand(params);
  await stagehand.init();

  console.log(`[stagehand] Session initialized in ${config.mode.toUpperCase()} mode`);
  return stagehand;
}
