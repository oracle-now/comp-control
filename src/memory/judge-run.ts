/**
 * memory/judge-run.ts
 *
 * Post-run judgement: call Claude with the complete step log after every
 * workflow run and get back a structured JudgementResult.
 *
 * Design rationale (browser-use pattern):
 *   browser-use's AgentHistoryList exposes a judge step at the end of each
 *   task to evaluate whether the goal was achieved. We port this pattern
 *   to comp-control: after the approval loop finishes, we send the full
 *   step log + run summary to Claude and ask for a verdict.
 *
 * The JudgementResult is then written into resolved.json under a
 * 'runAudits' key so every run is auditable without opening logs.
 *
 * Three fields (required, align with browser-use's done() output contract):
 *   verdict        — 'success' | 'partial' | 'failure'
 *   failureReason  — null when success; specific reason string when partial/failure
 *   reachedCaptcha — true if the agent hit a CAPTCHA wall at any point
 *
 * Additional fields carry forward the run summary data so the audit
 * record is self-contained (no need to cross-reference log files).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { StepRecord } from './summarize-history.js';
import type { RunSummary } from '../agents/accountant.agent.js';
import { log } from '../utils/logger.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Verdict of a completed agent run.
 *
 *   success  — All available items were reviewed; no unhandled errors
 *   partial  — Run completed but with degraded results (some items skipped,
 *              non-fatal errors, CAPTCHA hit mid-run but recovered)
 *   failure  — Run did not complete its core task (login failure, CAPTCHA
 *              blocked the entire run, repeated loop-detection nudges,
 *              unhandled exception before reaching the queue)
 */
export type Verdict = 'success' | 'partial' | 'failure';

/**
 * JudgementResult — the primary interface.
 * Returned by judgeRun() and written into resolved.json.
 */
export interface JudgementResult {
  /** Overall verdict for this run */
  verdict: Verdict;

  /**
   * Human-readable explanation of why the run was partial or failed.
   * null when verdict === 'success'.
   */
  failureReason: string | null;

  /**
   * True if a CAPTCHA was encountered at any point during the run.
   * A CAPTCHA can degrade a run to 'partial' or block it entirely ('failure').
   * Kept as a top-level flag (not just buried in failureReason) because it
   * drives a distinct operational response: rotate session, use Browserbase
   * anti-detect, or trigger a human review.
   */
  reachedCaptcha: boolean;

  /** Stats carried from RunSummary for a self-contained audit record */
  totalReviewed: number;
  totalApproved: number;
  totalFlagged: number;
  totalSkipped: number;
  durationMs: number;

  /** ISO timestamp of when the judgement was produced */
  judgedAt: string;

  /** Which prompt mode was active (full | flash) */
  promptMode: string;

  /** Raw Claude response text, stored for audit/debugging */
  rawJudgeResponse: string;
}

/**
 * Input to the judge — passed from the agent after the approval loop.
 */
export interface JudgeRunInput {
  steps: readonly StepRecord[];
  summary: RunSummary;
  targetUrl: string;
}

// ─── Prompt construction ─────────────────────────────────────────────────────────

export const JUDGE_SYSTEM_PROMPT = `You are a run auditor for an AP expense review automation system.
You receive the complete step log and summary of a completed agent run and must evaluate whether the run achieved its goal.

Your job is to output a JSON object with exactly these four fields:
  "verdict"        — one of: "success", "partial", "failure"
  "failureReason"  — string describing why the run was partial or failed, or null if success
  "reachedCaptcha" — boolean: true if any step mentions CAPTCHA, challenge page, or bot detection

Verdict criteria:
  success  — The run reviewed all available items, approved/flagged each one, no unrecovered errors
  partial  — The run completed but with gaps: items skipped, non-fatal errors, loop-detection nudges fired,
             CAPTCHA encountered but recovered, or only a subset of items were processed
  failure  — The run did not complete its core task: login failed, CAPTCHA blocked the entire run,
             unhandled exception before the queue was reached, or zero items were reviewed despite items existing

Rules:
  - If errors[] is non-empty AND totalReviewed === 0, verdict must be "failure"
  - If reachedCaptcha is true AND totalReviewed === 0, verdict must be "failure"
  - If reachedCaptcha is true AND totalReviewed > 0, verdict is "partial" (not success)
  - failureReason must be null when verdict is "success" — not an empty string, null
  - Be specific in failureReason: quote the relevant step or error message

Output ONLY the JSON object. No markdown, no explanation, no code fences.`;

export function buildJudgePrompt(input: JudgeRunInput): string {
  const { steps, summary, targetUrl } = input;

  const stepLines = steps
    .map(s => {
      const parts = [`Step ${s.stepNumber} [${s.outcome}]: ${s.action}`];
      if (s.detail) parts.push(`  ↳ ${s.detail}`);
      if (s.url) parts.push(`  ↳ url: ${s.url}`);
      return parts.join('\n');
    })
    .join('\n');

  return `## Run metadata
Target URL: ${targetUrl}
Prompt mode: ${summary.promptMode}
Duration: ${summary.durationMs}ms
Dry run: ${String((summary as RunSummary & { dryRun?: boolean }).dryRun ?? false)}

## Run summary
Total reviewed: ${summary.totalReviewed}
Total approved: ${summary.totalApproved}
Total flagged:  ${summary.totalFlagged}
Total skipped:  ${summary.totalSkipped}
Errors: ${summary.errors.length === 0 ? 'none' : summary.errors.map(e => `  - ${e}`).join('\n')}

## Full step log (${steps.length} steps)
${stepLines || '(no steps recorded)'}

Please produce the JudgementResult JSON object now.`;
}

// ─── judgeRun() ──────────────────────────────────────────────────────────────────

/**
 * Call Claude after a completed run and return a typed JudgementResult.
 *
 * Uses claude-haiku-3-5 by default — this is a structured extraction call
 * over text, not a reasoning task. Haiku handles it well at low cost.
 * Override with COMP_CONTROL_JUDGE_MODEL env var for one-off debugging.
 *
 * Never throws — returns a synthetic 'failure' judgement with the error
 * message if the API call itself fails, so the audit trail is never broken.
 */
export async function judgeRun(
  input: JudgeRunInput,
  client: Anthropic
): Promise<JudgementResult> {
  const model =
    process.env['COMP_CONTROL_JUDGE_MODEL'] ?? 'claude-haiku-3-5';

  const userPrompt = buildJudgePrompt(input);

  let rawResponse = '';

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 512, // JudgementResult JSON is ~150 tokens; 512 is generous
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    rawResponse =
      message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

    // Strip accidental markdown fences if the model wraps the JSON
    const cleaned = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as {
      verdict: Verdict;
      failureReason: string | null;
      reachedCaptcha: boolean;
    };

    // Validate required fields
    if (!['success', 'partial', 'failure'].includes(parsed.verdict)) {
      throw new Error(`Invalid verdict: ${String(parsed.verdict)}`);
    }
    if (typeof parsed.reachedCaptcha !== 'boolean') {
      throw new Error('reachedCaptcha must be a boolean');
    }
    if (parsed.verdict === 'success' && parsed.failureReason !== null) {
      parsed.failureReason = null; // enforce invariant
    }

    const result: JudgementResult = {
      verdict: parsed.verdict,
      failureReason: parsed.failureReason ?? null,
      reachedCaptcha: parsed.reachedCaptcha,
      totalReviewed: input.summary.totalReviewed,
      totalApproved: input.summary.totalApproved,
      totalFlagged: input.summary.totalFlagged,
      totalSkipped: input.summary.totalSkipped,
      durationMs: input.summary.durationMs,
      judgedAt: new Date().toISOString(),
      promptMode: input.summary.promptMode,
      rawJudgeResponse: rawResponse,
    };

    log.info(`[Judge] Verdict: ${result.verdict}`, {
      failureReason: result.failureReason,
      reachedCaptcha: result.reachedCaptcha,
    });

    return result;

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`[Judge] Judgement call failed: ${errMsg}`);

    // Synthetic failure judgement — never breaks the audit trail
    return {
      verdict: 'failure',
      failureReason: `Judge API call failed: ${errMsg}`,
      reachedCaptcha: false,
      totalReviewed: input.summary.totalReviewed,
      totalApproved: input.summary.totalApproved,
      totalFlagged: input.summary.totalFlagged,
      totalSkipped: input.summary.totalSkipped,
      durationMs: input.summary.durationMs,
      judgedAt: new Date().toISOString(),
      promptMode: input.summary.promptMode,
      rawJudgeResponse: rawResponse,
    };
  }
}
