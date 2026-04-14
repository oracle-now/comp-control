/**
 * intelligence/duplicate-detector.ts
 *
 * Zero-LLM pattern matching for duplicate charges.
 *
 * Three types of duplicates this catches:
 *
 * 1. DOUBLE BILLING — vendor charged the card twice for the same thing.
 *    Same vendor + same amount + within 7 days = probable duplicate.
 *    Common with: subscription renewals that fire twice, manual invoices
 *    paid by card AND check, vendors with billing system bugs.
 *
 * 2. DOUBLE EXPENSING — two employees charged the same team expense.
 *    Same vendor + same amount + same day + different cardholders.
 *    Common with: team lunch where two people both tap their Ramp cards,
 *    conference registrations where the attendee AND their manager both charge.
 *
 * 3. SPLIT TRANSACTION — one large purchase split across multiple smaller
 *    charges to stay under an approval threshold. Same vendor + multiple
 *    charges on the same day that sum to a round number.
 *    This is a controls concern, not just a duplicate.
 *
 * No LLM needed — all deterministic logic. Runs first in the pipeline
 * as a cheap pre-filter before enrichment.
 */

import type { TransactionContext } from '../enrichment/enrich-transaction.js';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type DuplicateType = 'double_billing' | 'double_expensing' | 'split_transaction';

export interface DuplicateMatch {
  type: DuplicateType;
  /** The transaction that triggered the flag */
  transactionId: string;
  /** The other transaction(s) it matched against */
  matchedTransactionIds: string[];
  vendor: string;
  amount: number;
  /** Human-readable explanation */
  explanation: string;
  /** Recommended action for the AP specialist */
  recommendedAction: string;
  /** Confidence this is actually a duplicate (vs coincidence) */
  confidence: 'high' | 'medium' | 'low';
}

export interface DuplicateReport {
  /** Transactions with no duplicate signals */
  clean: TransactionContext[];
  /** Transactions flagged as potential duplicates */
  flagged: DuplicateMatch[];
  /** Summary counts */
  summary: {
    totalChecked: number;
    doubleBilling: number;
    doubleExpensing: number;
    splitTransaction: number;
    estimatedDuplicateSpend: number;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeVendor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / msPerDay;
}

function amountsMatch(a: number, b: number, tolerancePct = 0.01): boolean {
  // 1% tolerance to catch minor rounding differences
  return Math.abs(a - b) / Math.max(a, b) <= tolerancePct;
}

function isRoundNumber(n: number): boolean {
  return n % 50 === 0 || n % 100 === 0 || n % 500 === 0;
}

// ── Duplicate detection ─────────────────────────────────────────────────────

export function detectDuplicates(
  transactions: TransactionContext[],
  options: {
    doubleBillingWindowDays?: number;
    splitTransactionWindowHours?: number;
  } = {}
): DuplicateReport {
  const {
    doubleBillingWindowDays = 7,
    splitTransactionWindowHours = 24,
  } = options;

  const flagged: DuplicateMatch[] = [];
  const flaggedIds = new Set<string>();

  // ── 1. Double billing ────────────────────────────────────────────────
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const matches: TransactionContext[] = [];

    for (let j = i + 1; j < transactions.length; j++) {
      const other = transactions[j];
      const sameVendor = normalizeVendor(tx.vendor) === normalizeVendor(other.vendor);
      const sameCardholder = tx.cardholderName === other.cardholderName;
      const sameAmount = amountsMatch(tx.amount, other.amount);
      const withinWindow = daysBetween(tx.transactionDate, other.transactionDate) <= doubleBillingWindowDays;

      if (sameVendor && sameCardholder && sameAmount && withinWindow) {
        matches.push(other);
      }
    }

    if (matches.length > 0 && !flaggedIds.has(tx.transactionId)) {
      const matchIds = matches.map(m => m.transactionId);
      flagged.push({
        type: 'double_billing',
        transactionId: tx.transactionId,
        matchedTransactionIds: matchIds,
        vendor: tx.vendor,
        amount: tx.amount,
        explanation:
          `"${tx.vendor}" charged $${tx.amount} ${matches.length + 1} times ` +
          `to ${tx.cardholderName} within ${doubleBillingWindowDays} days.`,
        recommendedAction:
          'Contact vendor to confirm only one charge was intended. Request credit memo for duplicate(s).',
        confidence: matches[0] && daysBetween(tx.transactionDate, matches[0].transactionDate) <= 2
          ? 'high'
          : 'medium',
      });
      flaggedIds.add(tx.transactionId);
      matchIds.forEach(id => flaggedIds.add(id));
    }
  }

  // ── 2. Double expensing (same vendor + amount, different cardholders, same day) ──
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (flaggedIds.has(tx.transactionId)) continue;
    const matches: TransactionContext[] = [];

    for (let j = i + 1; j < transactions.length; j++) {
      const other = transactions[j];
      const sameVendor = normalizeVendor(tx.vendor) === normalizeVendor(other.vendor);
      const differentCardholder = tx.cardholderName !== other.cardholderName;
      const sameAmount = amountsMatch(tx.amount, other.amount);
      const sameDay = daysBetween(tx.transactionDate, other.transactionDate) < 1;

      if (sameVendor && differentCardholder && sameAmount && sameDay) {
        matches.push(other);
      }
    }

    if (matches.length > 0) {
      flagged.push({
        type: 'double_expensing',
        transactionId: tx.transactionId,
        matchedTransactionIds: matches.map(m => m.transactionId),
        vendor: tx.vendor,
        amount: tx.amount,
        explanation:
          `${tx.cardholderName} and ${matches[0]?.cardholderName} both charged ` +
          `$${tx.amount} at "${tx.vendor}" on the same day.`,
        recommendedAction:
          'Ask both cardholders to confirm who should keep this charge. One needs to reverse theirs.',
        confidence: 'high',
      });
    }
  }

  // ── 3. Split transaction detection ────────────────────────────────────
  const byCardholderVendor = new Map<string, TransactionContext[]>();

  for (const tx of transactions) {
    const key = `${tx.cardholderName}::${normalizeVendor(tx.vendor)}`;
    if (!byCardholderVendor.has(key)) byCardholderVendor.set(key, []);
    byCardholderVendor.get(key)!.push(tx);
  }

  for (const [, group] of byCardholderVendor) {
    if (group.length < 2) continue;

    // Check for multiple charges to same vendor within split window
    for (let i = 0; i < group.length; i++) {
      const tx = group[i];
      const sameDay = group.filter(
        other =>
          other.transactionId !== tx.transactionId &&
          daysBetween(tx.transactionDate, other.transactionDate) * 24 <= splitTransactionWindowHours
      );

      if (sameDay.length >= 1) {
        const total = sameDay.reduce((sum, t) => sum + t.amount, tx.amount);
        if (isRoundNumber(total) && !flaggedIds.has(tx.transactionId)) {
          flagged.push({
            type: 'split_transaction',
            transactionId: tx.transactionId,
            matchedTransactionIds: sameDay.map(t => t.transactionId),
            vendor: tx.vendor,
            amount: total,
            explanation:
              `${tx.cardholderName} made ${sameDay.length + 1} charges to "${tx.vendor}" ` +
              `within ${splitTransactionWindowHours}h totaling $${total} (a round number).`,
            recommendedAction:
              'Verify this was not split to stay under an approval threshold. If legitimate, request a single consolidated receipt.',
            confidence: 'medium',
          });
          flaggedIds.add(tx.transactionId);
        }
      }
    }
  }

  const clean = transactions.filter(tx => !flaggedIds.has(tx.transactionId));

  const summary = {
    totalChecked: transactions.length,
    doubleBilling: flagged.filter(f => f.type === 'double_billing').length,
    doubleExpensing: flagged.filter(f => f.type === 'double_expensing').length,
    splitTransaction: flagged.filter(f => f.type === 'split_transaction').length,
    estimatedDuplicateSpend: flagged.reduce((sum, f) => sum + f.amount, 0),
  };

  if (flagged.length > 0) {
    log.warn(`[Duplicates] Found ${flagged.length} duplicate signals totaling $${summary.estimatedDuplicateSpend}`);
  }

  return { clean, flagged, summary };
}
