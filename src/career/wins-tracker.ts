/**
 * career/wins-tracker.ts
 *
 * Your professional record of impact.
 *
 * AP is invisible when it works. Duplicate charges get caught,
 * bad GL codes get corrected, cardholder questions get answered.
 * None of that shows up in a performance review unless YOU track it.
 *
 * This module logs every win — money saved, errors caught, process
 * improved, cardholder educated — and maintains a running total that
 * you can pull up in any 1:1, performance review, or "what have you
 * been working on?" conversation.
 *
 * Win categories:
 *   DUPLICATE_CAUGHT     — actual dollar amount recovered or avoided
 *   VENDOR_SAVINGS       — negotiated better pricing or cancelled unused sub
 *   GL_CORRECTION        — wrong code caught before books closed
 *   POLICY_ENFORCEMENT   — flagged non-compliant charge, prevented future ones
 *   PROCESS_IMPROVEMENT  — built something that saves time going forward
 *   CARDHOLDER_EDUCATION — taught someone the right way to do something
 *   ESCALATION_RESOLVED  — handled something that could have become a problem
 *   ACCRUAL_ACCURACY     — caught a missing accrual before close
 *
 * The brag doc entry format is designed to be copy-paste ready
 * into a performance self-review or LinkedIn post.
 */

import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type WinCategory =
  | 'DUPLICATE_CAUGHT'
  | 'VENDOR_SAVINGS'
  | 'GL_CORRECTION'
  | 'POLICY_ENFORCEMENT'
  | 'PROCESS_IMPROVEMENT'
  | 'CARDHOLDER_EDUCATION'
  | 'ESCALATION_RESOLVED'
  | 'ACCRUAL_ACCURACY';

export interface Win {
  id: string;
  date: string;                    // ISO date
  category: WinCategory;
  title: string;                   // one-line summary
  detail: string;                  // what exactly happened
  dollarImpact: number;            // 0 if non-monetary
  dollarImpactType: 'saved' | 'recovered' | 'avoided' | 'corrected' | 'none';
  vendorOrCardholder?: string;     // who was involved
  transactionId?: string;          // link to the source transaction
  /**
   * Auto-generated brag doc entry.
   * Past tense, quantified, ready for copy-paste.
   * e.g. "Identified and recovered a $340 duplicate charge from Vendor X,
   *        preventing a $680 overstatement of Q2 COGS."
   */
  bragEntry: string;
  tags: string[];
}

export interface WinsSummary {
  totalWins: number;
  totalDollarImpact: number;
  byCategory: Record<WinCategory, number>;
  topWins: Win[];
  periodSummary: string;   // the paragraph for your performance review
  since: string;           // ISO date of oldest win
}

// ── Storage ───────────────────────────────────────────────────────────────

const WINS_PATH = path.resolve(process.cwd(), 'data/wins.json');

function loadWins(): Win[] {
  try {
    if (fs.existsSync(WINS_PATH)) return JSON.parse(fs.readFileSync(WINS_PATH, 'utf-8'));
  } catch { /* ignore */ }
  return [];
}

function saveWins(wins: Win[]): void {
  const dir = path.dirname(WINS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WINS_PATH, JSON.stringify(wins, null, 2));
}

function generateId(): string {
  return `win_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Core functions ─────────────────────────────────────────────────────────

export function logWin(
  params: Omit<Win, 'id' | 'bragEntry'> & { bragEntry?: string }
): Win {
  const wins = loadWins();

  const bragEntry = params.bragEntry ?? generateBragEntry(params);

  const win: Win = {
    ...params,
    id: generateId(),
    bragEntry,
  };

  wins.unshift(win); // newest first
  saveWins(wins);

  log.info(`[⭐ Win logged] ${win.category}: ${win.title}${
    win.dollarImpact > 0 ? ` (+$${win.dollarImpact} ${win.dollarImpactType})` : ''
  }`);

  return win;
}

function generateBragEntry(
  params: Omit<Win, 'id' | 'bragEntry'>
): string {
  const { category, detail, dollarImpact, dollarImpactType, vendorOrCardholder } = params;

  const dollarPhrase = dollarImpact > 0
    ? ` $${dollarImpact.toLocaleString()} ${dollarImpactType}`
    : '';

  const vendorPhrase = vendorOrCardholder ? ` (${vendorOrCardholder})` : '';

  const templates: Record<WinCategory, string> = {
    DUPLICATE_CAUGHT:
      `Identified and recovered${dollarPhrase} in duplicate charges${vendorPhrase}. ${detail}`,
    VENDOR_SAVINGS:
      `Negotiated or identified${dollarPhrase} in vendor savings${vendorPhrase}. ${detail}`,
    GL_CORRECTION:
      `Caught and corrected${dollarPhrase ? ` a${dollarPhrase}` : ' a'} GL miscoding${vendorPhrase} before period close. ${detail}`,
    POLICY_ENFORCEMENT:
      `Enforced T&E policy${vendorPhrase}, preventing non-compliant spend${dollarPhrase ? ` of${dollarPhrase}` : ''}. ${detail}`,
    PROCESS_IMPROVEMENT:
      `Improved AP process${dollarPhrase ? `, saving an estimated${dollarPhrase} annually` : ''}. ${detail}`,
    CARDHOLDER_EDUCATION:
      `Educated cardholder${vendorPhrase} on expense policy, reducing future non-compliance. ${detail}`,
    ESCALATION_RESOLVED:
      `Escalated and resolved${dollarPhrase ? ` a${dollarPhrase}` : ' an'} AP issue${vendorPhrase} before it impacted close. ${detail}`,
    ACCRUAL_ACCURACY:
      `Identified missing accrual${dollarPhrase ? ` of${dollarPhrase}` : ''}${vendorPhrase}, ensuring accurate period-end reporting. ${detail}`,
  };

  return templates[category];
}

/**
 * Get a full wins summary for a given period.
 * Default: all time. Pass sinceDate to scope it.
 */
export function getWinsSummary(sinceDate?: string): WinsSummary {
  const wins = loadWins();
  const filtered = sinceDate
    ? wins.filter(w => w.date >= sinceDate)
    : wins;

  const byCategory = {} as Record<WinCategory, number>;
  const categories: WinCategory[] = [
    'DUPLICATE_CAUGHT', 'VENDOR_SAVINGS', 'GL_CORRECTION',
    'POLICY_ENFORCEMENT', 'PROCESS_IMPROVEMENT', 'CARDHOLDER_EDUCATION',
    'ESCALATION_RESOLVED', 'ACCRUAL_ACCURACY',
  ];
  for (const cat of categories) byCategory[cat] = 0;

  let totalDollar = 0;
  for (const w of filtered) {
    byCategory[w.category]++;
    totalDollar += w.dollarImpact;
  }

  const topWins = filtered
    .filter(w => w.dollarImpact > 0)
    .sort((a, b) => b.dollarImpact - a.dollarImpact)
    .slice(0, 5);

  const period = sinceDate
    ? `Since ${new Date(sinceDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
    : 'All time';

  const periodSummary = [
    `${period}, identified and resolved ${filtered.length} AP issues totaling`,
    `$${totalDollar.toLocaleString()} in financial impact.`,
    byCategory.DUPLICATE_CAUGHT > 0
      ? `Caught ${byCategory.DUPLICATE_CAUGHT} duplicate charge${byCategory.DUPLICATE_CAUGHT > 1 ? 's' : ''}.`
      : '',
    byCategory.VENDOR_SAVINGS > 0
      ? `Generated $${filtered.filter(w => w.category === 'VENDOR_SAVINGS').reduce((s, w) => s + w.dollarImpact, 0).toLocaleString()} in vendor savings.`
      : '',
    byCategory.GL_CORRECTION > 0
      ? `Corrected ${byCategory.GL_CORRECTION} GL miscodings before period close.`
      : '',
    byCategory.PROCESS_IMPROVEMENT > 0
      ? `Drove ${byCategory.PROCESS_IMPROVEMENT} process improvement${byCategory.PROCESS_IMPROVEMENT > 1 ? 's' : ''}.`
      : '',
  ].filter(Boolean).join(' ');

  return {
    totalWins: filtered.length,
    totalDollarImpact: totalDollar,
    byCategory,
    topWins,
    periodSummary,
    since: filtered[filtered.length - 1]?.date ?? new Date().toISOString(),
  };
}

/**
 * Auto-log wins from the pipeline outputs.
 * Call this at the end of each run with the results.
 */
export function autoLogRunWins(params: {
  duplicateMatches: { vendor: string; amount: number; transactionId: string; type: string }[];
  glCorrections: { vendor: string; amount: number; transactionId: string; correctedFrom: string; correctedTo: string }[];
  escalationsResolved: { vendor: string; amount: number; transactionId: string }[];
}): Win[] {
  const logged: Win[] = [];

  for (const dup of params.duplicateMatches) {
    logged.push(logWin({
      date: new Date().toISOString().split('T')[0]!,
      category: 'DUPLICATE_CAUGHT',
      title: `Caught ${dup.type} — ${dup.vendor} $${dup.amount}`,
      detail: `${dup.type === 'double_billing' ? 'Vendor double-charged the card.' : 'Two employees both charged the same expense.'} Transaction ID: ${dup.transactionId}.`,
      dollarImpact: dup.amount,
      dollarImpactType: 'recovered',
      vendorOrCardholder: dup.vendor,
      transactionId: dup.transactionId,
      tags: ['automated', 'duplicate'],
    }));
  }

  for (const gl of params.glCorrections) {
    logged.push(logWin({
      date: new Date().toISOString().split('T')[0]!,
      category: 'GL_CORRECTION',
      title: `GL corrected: ${gl.vendor} $${gl.amount} — ${gl.correctedFrom} → ${gl.correctedTo}`,
      detail: `Reclassified from ${gl.correctedFrom} to ${gl.correctedTo} before period close.`,
      dollarImpact: gl.amount,
      dollarImpactType: 'corrected',
      vendorOrCardholder: gl.vendor,
      transactionId: gl.transactionId,
      tags: ['automated', 'gl-coding'],
    }));
  }

  return logged;
}
