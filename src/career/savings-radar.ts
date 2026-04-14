/**
 * career/savings-radar.ts
 *
 * Finds money-saving opportunities in your spend data.
 * This is how you "look like a star" — not by cutting costs randomly,
 * but by surfacing specific, actionable opportunities with numbers attached.
 *
 * Five opportunity types:
 *
 * 1. DUPLICATE_SUBSCRIPTIONS
 *    Two teams paying for the same SaaS tool separately.
 *    E.g. Engineering using Loom Pro ($15/user) AND Marketing using
 *    Loom Business ($25/user). Consolidate to one contract at volume pricing.
 *
 * 2. VOLUME_DISCOUNT_OPPORTUNITY
 *    A vendor you're spending $X/year with that offers volume discounts
 *    you haven't negotiated. Most SaaS vendors will discount 15-20% for
 *    annual commitments or volume if you just ask.
 *
 * 3. UNUSED_SUBSCRIPTION
 *    Subscription charged monthly with no observable usage pattern.
 *    E.g. Zoom Webinar tier but the last webinar was 6 months ago.
 *
 * 4. RENEWAL_NEGOTIATION_WINDOW
 *    Annual contracts coming up for renewal in 30-60 days. The window
 *    to negotiate is BEFORE auto-renewal, not after.
 *
 * 5. VENDOR_CONSOLIDATION
 *    Multiple vendors doing overlapping things. E.g. Asana, Monday,
 *    and Linear all being used by different teams.
 *
 * For each opportunity: estimated savings, who owns the relationship,
 * talking points for the negotiation conversation.
 */

import type { TransactionContext } from '../enrichment/enrich-transaction.js';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type SavingsOpportunityType =
  | 'DUPLICATE_SUBSCRIPTIONS'
  | 'VOLUME_DISCOUNT'
  | 'UNUSED_SUBSCRIPTION'
  | 'RENEWAL_WINDOW'
  | 'VENDOR_CONSOLIDATION';

export interface SavingsOpportunity {
  type: SavingsOpportunityType;
  title: string;
  estimatedAnnualSavings: number;       // conservative estimate
  estimatedSavingsRange: string;        // e.g. "$1,200–$2,400/year"
  vendors: string[];
  cardholders: string[];               // who to talk to internally
  /**
   * The conversation starter for the internal meeting.
   * Specific, with numbers. Not "we should look at this."
   */
  internalTalkingPoint: string;
  /**
   * What to say to the vendor when negotiating.
   * Reference to competitors, volume, commitment, timing.
   */
  vendorTalkingPoint: string | null;
  evidence: string;                    // what in the data supports this
  priority: 'high' | 'medium' | 'low';
  detectedAt: string;
}

export interface SavingsReport {
  opportunities: SavingsOpportunity[];
  totalEstimatedAnnualSavings: number;
  quickWins: SavingsOpportunity[];     // high priority, under 1hr to pursue
  summary: string;
}

// ── Analysis ──────────────────────────────────────────────────────────────

/**
 * Analyze a rolling window of transactions for savings opportunities.
 * Pass 90+ days of transactions for reliable signal.
 */
export function runSavingsRadar(
  transactions: TransactionContext[]
): SavingsReport {
  const opportunities: SavingsOpportunity[] = [];

  // ── Build vendor spend map ──────────────────────────────────────────
  interface VendorStats {
    normalizedName: string;
    rawNames: Set<string>;
    totalSpend: number;
    chargeCount: number;
    cardholders: Set<string>;
    lastCharge: string;
    firstCharge: string;
    monthlyAmounts: number[];
    isMonthly: boolean;
  }

  const vendorMap = new Map<string, VendorStats>();

  for (const tx of transactions) {
    const key = tx.vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!vendorMap.has(key)) {
      vendorMap.set(key, {
        normalizedName: key,
        rawNames: new Set(),
        totalSpend: 0,
        chargeCount: 0,
        cardholders: new Set(),
        lastCharge: tx.transactionDate,
        firstCharge: tx.transactionDate,
        monthlyAmounts: [],
        isMonthly: false,
      });
    }
    const stats = vendorMap.get(key)!;
    stats.rawNames.add(tx.vendor);
    stats.totalSpend += tx.amount;
    stats.chargeCount++;
    stats.cardholders.add(tx.cardholderName);
    if (tx.transactionDate > stats.lastCharge) stats.lastCharge = tx.transactionDate;
    if (tx.transactionDate < stats.firstCharge) stats.firstCharge = tx.transactionDate;
    stats.monthlyAmounts.push(tx.amount);
  }

  // Detect monthly recurring pattern
  for (const [, stats] of vendorMap) {
    if (stats.chargeCount >= 2) {
      const avgAmount = stats.totalSpend / stats.chargeCount;
      const allSimilar = stats.monthlyAmounts.every(a => Math.abs(a - avgAmount) / avgAmount < 0.1);
      stats.isMonthly = allSimilar;
    }
  }

  // ── 1. Duplicate subscriptions (same type, multiple cardholders) ───────
  // Group vendors by category similarity using keyword matching
  const projectMgmt = ['asana', 'monday', 'linear', 'jira', 'clickup', 'notion', 'basecamp'];
  const videoConference = ['zoom', 'teams', 'meet', 'webex', 'whereby'];
  const design = ['figma', 'sketch', 'canva', 'adobe', 'framer'];
  const communication = ['slack', 'discord', 'teams', 'basecamp'];
  const categories = [projectMgmt, videoConference, design, communication];
  const categoryNames = ['project management', 'video conferencing', 'design tools', 'communication'];

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    const catName = categoryNames[i]!;
    const matchingVendors: VendorStats[] = [];

    for (const [key, stats] of vendorMap) {
      if (cat.some(keyword => key.includes(keyword))) {
        matchingVendors.push(stats);
      }
    }

    if (matchingVendors.length >= 2) {
      const totalSpend = matchingVendors.reduce((s, v) => s + v.totalSpend, 0);
      const vendors = matchingVendors.flatMap(v => [...v.rawNames]).slice(0, 3);
      const cardholders = [...new Set(matchingVendors.flatMap(v => [...v.cardholders]))];

      opportunities.push({
        type: 'DUPLICATE_SUBSCRIPTIONS',
        title: `${matchingVendors.length} ${catName} tools — consolidation opportunity`,
        estimatedAnnualSavings: Math.round(totalSpend * 0.3),
        estimatedSavingsRange: `$${Math.round(totalSpend * 0.2).toLocaleString()}–$${Math.round(totalSpend * 0.4).toLocaleString()}/year`,
        vendors,
        cardholders: cardholders.slice(0, 4),
        internalTalkingPoint:
          `We're paying for ${vendors.join(', ')} — all ${catName} tools — totaling ~$${totalSpend.toLocaleString()} over the past few months. ` +
          `Can we align on one platform? I can pull usage data to see which one people actually use.`,
        vendorTalkingPoint:
          `We're currently evaluating consolidating all ${catName} spend to one vendor. ` +
          `We'd like to discuss what you can offer for an annual commitment covering our full team.`,
        evidence: `${matchingVendors.length} vendors found: ${vendors.join(', ')}. Combined spend in dataset.`,
        priority: totalSpend > 500 ? 'high' : 'medium',
        detectedAt: new Date().toISOString(),
      });
    }
  }

  // ── 2. Volume discount opportunities (high annual spend, likely monthly) ──
  for (const [, stats] of vendorMap) {
    const annualizedSpend = stats.totalSpend * (12 / Math.max(
      1,
      (new Date(stats.lastCharge).getTime() - new Date(stats.firstCharge).getTime()) / (30 * 24 * 60 * 60 * 1000)
    ));

    if (annualizedSpend >= 3000 && stats.isMonthly) {
      const vendor = [...stats.rawNames][0] ?? 'Unknown';
      opportunities.push({
        type: 'VOLUME_DISCOUNT',
        title: `${vendor} — ~$${Math.round(annualizedSpend / 100) * 100}/yr, no annual contract`,
        estimatedAnnualSavings: Math.round(annualizedSpend * 0.15),
        estimatedSavingsRange: `$${Math.round(annualizedSpend * 0.10).toLocaleString()}–$${Math.round(annualizedSpend * 0.20).toLocaleString()}/year`,
        vendors: [vendor],
        cardholders: [...stats.cardholders].slice(0, 2),
        internalTalkingPoint:
          `We're paying ${vendor} ~$${Math.round(stats.totalSpend / stats.chargeCount).toLocaleString()}/month ` +
          `(~$${Math.round(annualizedSpend).toLocaleString()}/year) on a month-to-month basis. ` +
          `An annual prepay usually gets 15-20% off. Can I get approval to commit annually?`,
        vendorTalkingPoint:
          `We've been a customer for ${stats.chargeCount} months and we're happy with the product. ` +
          `We'd like to discuss an annual contract — what can you offer for an upfront annual commitment?`,
        evidence: `${stats.chargeCount} monthly charges averaging $${Math.round(stats.totalSpend / stats.chargeCount).toLocaleString()}. No annual contract detected.`,
        priority: annualizedSpend >= 10000 ? 'high' : 'medium',
        detectedAt: new Date().toISOString(),
      });
    }
  }

  // ── 3. Unused subscriptions (charged monthly, last charge was 60+ days ago) ──
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
  for (const [, stats] of vendorMap) {
    if (stats.isMonthly && stats.lastCharge < sixtyDaysAgo) {
      const vendor = [...stats.rawNames][0] ?? 'Unknown';
      const monthlyRate = stats.totalSpend / stats.chargeCount;
      opportunities.push({
        type: 'UNUSED_SUBSCRIPTION',
        title: `${vendor} — no charge in 60+ days, may be cancelled or unused`,
        estimatedAnnualSavings: Math.round(monthlyRate * 12),
        estimatedSavingsRange: `$${Math.round(monthlyRate * 12).toLocaleString()}/year if cancelled`,
        vendors: [vendor],
        cardholders: [...stats.cardholders].slice(0, 2),
        internalTalkingPoint:
          `${vendor} was being charged ~$${Math.round(monthlyRate).toLocaleString()}/month but we haven't seen a charge since ${stats.lastCharge}. ` +
          `Is this still in use? If not, let's make sure we've formally cancelled to avoid unexpected future charges.`,
        vendorTalkingPoint: null,
        evidence: `Last charge: ${stats.lastCharge}. Was previously monthly ($${Math.round(monthlyRate).toLocaleString()}/mo avg).`,
        priority: monthlyRate >= 200 ? 'high' : 'low',
        detectedAt: new Date().toISOString(),
      });
    }
  }

  // Sort by estimated savings descending
  opportunities.sort((a, b) => b.estimatedAnnualSavings - a.estimatedAnnualSavings);

  const total = opportunities.reduce((s, o) => s + o.estimatedAnnualSavings, 0);
  const quickWins = opportunities.filter(o => o.priority === 'high').slice(0, 3);

  const summary = opportunities.length > 0
    ? `Found ${opportunities.length} savings opportunities totaling ~$${total.toLocaleString()}/year. ` +
      `Top opportunity: ${opportunities[0]?.title}. Focus on the ${quickWins.length} high-priority items first.`
    : 'No savings opportunities detected in the current dataset. Run with 90+ days of transactions for best results.';

  log.info(`[SavingsRadar] ${opportunities.length} opportunities, ~$${total.toLocaleString()}/year potential`);

  return { opportunities, totalEstimatedAnnualSavings: total, quickWins, summary };
}
