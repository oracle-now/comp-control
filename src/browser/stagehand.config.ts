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
 *
 * Stagehand v3 API changes from v1/v2:
 *   - modelName + modelClientOptions -> model: { modelName, apiKey }
 *   - enableCaching: true -> cacheDir: "./stagehand-cache"
 *   - domSettleTimeoutMs -> domSettleTimeout
 *   - headless is set via browserOptions, not top-level
 *   - act/observe/extract are on the stagehand instance (not page)
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
    verbose: config.verbose ? 1 : 0,
    // v3: unified model config — provider/model string format
    model: {
      modelName: 'claude-sonnet-4-5',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    // v3: cacheDir replaces enableCaching boolean
    cacheDir: './stagehand-cache',
    // v3: domSettleTimeout (was domSettleTimeoutMs)
    domSettleTimeout: 3000,
    // v3: headless moved to browserOptions
    ...(config.headless !== undefined ? {
      browserOptions: {
        headless: config.headless,
      }
    } : {}),
  };

  const stagehand = new Stagehand(params);
  await stagehand.init();

  console.log(`[stagehand] Session initialized — ${config.mode.toUpperCase()} mode`);
  return stagehand;
}
