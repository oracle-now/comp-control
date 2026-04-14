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
 * Stagehand v3 API notes:
 *   - modelName + modelClientOptions -> model: { modelName, apiKey }
 *   - enableCaching: true -> cacheDir: "./stagehand-cache"
 *   - domSettleTimeoutMs -> domSettleTimeout
 *   - headless is set via browserOptions, not top-level
 *   - ConstructorParams is NOT a named export in v3 — drop the import,
 *     TypeScript infers the constructor param type automatically.
 */

import { Stagehand } from '@browserbasehq/stagehand';

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

  // ConstructorParams is not a named export in v3 — pass the object directly
  // and let TypeScript infer the type from the Stagehand constructor signature.
  const stagehand = new Stagehand({
    env: isCloud ? 'BROWSERBASE' : 'LOCAL',
    apiKey: isCloud ? process.env.BROWSERBASE_API_KEY : undefined,
    projectId: isCloud ? process.env.BROWSERBASE_PROJECT_ID : undefined,
    verbose: config.verbose ? 1 : 0,
    model: {
      modelName: 'claude-sonnet-4-5',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    cacheDir: './stagehand-cache',
    domSettleTimeout: 3000,
    ...(config.headless !== undefined ? {
      browserOptions: { headless: config.headless },
    } : {}),
  });

  await stagehand.init();

  console.log(`[stagehand] Session initialized — ${config.mode.toUpperCase()} mode`);
  return stagehand;
}
