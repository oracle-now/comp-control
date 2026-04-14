/**
 * career/po-bridge.ts
 *
 * Lightweight PO tracking for the 6-month gap before procurement arrives.
 *
 * You are holding the fort. That means:
 *   1. Tracking verbal/email approvals so nothing is "unauthorized spend"
 *   2. Building a spend pattern baseline that procurement will inherit
 *   3. Flagging recurring spend that SHOULD be on a contract
 *   4. Creating records that auto-migrate to whatever PO system arrives
 *
 * This is not a PO system. It's a bridge — lightweight enough to
 * actually use, structured enough to hand off cleanly.
 *
 * Three things it tracks:
 *
 * APPROVAL_RECORD
 *   "Marcus's manager approved the $4,000 AWS upgrade verbally on 4/10."
 *   Turns informal approvals into something you can reference.
 *
 * RECURRING_SPEND_PROFILE
 *   "We've paid Figma $450/mo for 8 months. This should be a contract."
 *   Surfaces the spend that procurement will want to formalize first.
 *
 * VENDOR_RELATIONSHIP
 *   "Sarah is the main contact at Salesforce. John owns the Figma relationship."
 *   Maps internal owners to vendors so there's no confusion when
 *   procurement arrives and asks "who handles this?"
 */

import fs from 'fs';
import path from 'path';
import type { TransactionContext } from '../enrichment/enrich-transaction.js';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  id: string;
  createdAt: string;
  vendorName: string;
  amount: number;
  approvedBy: string;           // name of person who approved
  approvedByRole: string;       // their title
  approvalMethod: 'verbal' | 'email' | 'slack' | 'formal_po' | 'retroactive';
  approvalDate: string;         // when they approved (ISO)
  approvalContext: string;      // what they actually said/wrote
  transactionIds: string[];     // transactions this approval covers
  isRecurring: boolean;
  recurringMonths?: number;     // how many months this approval covers
  expiresAt?: string;           // ISO date if approval has an end date
  status: 'active' | 'expired' | 'superseded';
}

export interface RecurringSpendProfile {
  vendorName: string;
  monthlyAmount: number;
  annualizedAmount: number;
  monthsObserved: number;
  primaryCardholder: string;
  internalOwner: string | null;   // who "owns" this vendor relationship
  contractStatus: 'no_contract' | 'verbal_only' | 'sow' | 'msa' | 'unknown';
  procurementPriority: 'high' | 'medium' | 'low';
  /**
   * What to tell procurement when they arrive.
   * Gives them the context to hit the ground running.
   */
  procurementHandoffNote: string;
  firstSeen: string;
  lastSeen: string;
}

export interface POBridgeStore {
  approvals: ApprovalRecord[];
  recurringProfiles: RecurringSpendProfile[];
  vendorOwners: Record<string, string>;  // vendor name -> internal owner name
}

// ── Storage ───────────────────────────────────────────────────────────────

const STORE_PATH = path.resolve(process.cwd(), 'data/po-bridge.json');

function loadStore(): POBridgeStore {
  try {
    if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch { /* ignore */ }
  return { approvals: [], recurringProfiles: [], vendorOwners: {} };
}

function saveStore(store: POBridgeStore): void {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── Core functions ─────────────────────────────────────────────────────────

export function recordApproval(
  params: Omit<ApprovalRecord, 'id' | 'createdAt' | 'status'>
): ApprovalRecord {
  const store = loadStore();
  const record: ApprovalRecord = {
    ...params,
    id: `apr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    status: 'active',
  };
  store.approvals.unshift(record);
  saveStore(store);
  log.info(`[POBridge] Approval recorded: ${params.vendorName} $${params.amount} approved by ${params.approvedBy}`);
  return record;
}

export function setVendorOwner(vendorName: string, ownerName: string): void {
  const store = loadStore();
  store.vendorOwners[vendorName.toLowerCase()] = ownerName;
  saveStore(store);
}

/**
 * Analyze transaction history and auto-generate recurring spend profiles.
 * Run this periodically to keep the bridge current.
 * Flags vendors that procurement should prioritize for formalization.
 */
export function buildRecurringProfiles(
  transactions: TransactionContext[]
): RecurringSpendProfile[] {
  const store = loadStore();

  // Group by vendor
  const vendorGroups = new Map<string, TransactionContext[]>();
  for (const tx of transactions) {
    const key = tx.vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!vendorGroups.has(key)) vendorGroups.set(key, []);
    vendorGroups.get(key)!.push(tx);
  }

  const profiles: RecurringSpendProfile[] = [];

  for (const [, txs] of vendorGroups) {
    if (txs.length < 2) continue; // need at least 2 charges to be "recurring"

    const vendor = txs[0]!.vendor;
    const total = txs.reduce((s, t) => s + t.amount, 0);
    const monthly = total / txs.length;
    const annualized = monthly * 12;

    // Only profile vendors above $100/mo threshold
    if (monthly < 100) continue;

    const cardholders = [...new Set(txs.map(t => t.cardholderName))];
    const internalOwner = store.vendorOwners[vendor.toLowerCase()] ?? null;
    const dates = txs.map(t => t.transactionDate).sort();
    const hasApproval = store.approvals.some(
      a => a.vendorName.toLowerCase().includes(vendor.toLowerCase()) && a.status === 'active'
    );

    const contractStatus = hasApproval ? 'verbal_only' : 'no_contract';
    const priority = annualized >= 10000 ? 'high' : annualized >= 3000 ? 'medium' : 'low';

    const handoffNote = [
      `${vendor}: ~$${Math.round(monthly).toLocaleString()}/mo ($${Math.round(annualized).toLocaleString()}/yr annualized).`,
      `${txs.length} charges observed since ${dates[0]}.`,
      internalOwner ? `Internal owner: ${internalOwner}.` : 'No internal owner assigned — assign before procurement handoff.',
      contractStatus === 'no_contract' ? 'No contract on file. Procurement should formalize.' : 'Verbal approval on record only.',
      cardholders.length > 1 ? `Multiple cardholders: ${cardholders.join(', ')}. May need consolidated billing.` : `Primary cardholder: ${cardholders[0]}.`,
    ].join(' ');

    profiles.push({
      vendorName: vendor,
      monthlyAmount: Math.round(monthly),
      annualizedAmount: Math.round(annualized),
      monthsObserved: txs.length,
      primaryCardholder: cardholders[0] ?? 'Unknown',
      internalOwner,
      contractStatus,
      procurementPriority: priority,
      procurementHandoffNote: handoffNote,
      firstSeen: dates[0]!,
      lastSeen: dates[dates.length - 1]!,
    });
  }

  // Sort by annualized spend descending
  profiles.sort((a, b) => b.annualizedAmount - a.annualizedAmount);

  // Save to store
  store.recurringProfiles = profiles;
  saveStore(store);

  log.info(`[POBridge] Built ${profiles.length} recurring spend profiles`);
  return profiles;
}

/**
 * Generate the procurement handoff document.
 * When the PO system arrives, you hand them this and they're up to speed.
 */
export function generateHandoffDoc(): string {
  const store = loadStore();
  const highPriority = store.recurringProfiles.filter(p => p.procurementPriority === 'high');
  const medPriority = store.recurringProfiles.filter(p => p.procurementPriority === 'medium');
  const totalAnnualized = store.recurringProfiles.reduce((s, p) => s + p.annualizedAmount, 0);

  return [
    '# AP → Procurement Handoff Document',
    `Generated: ${new Date().toLocaleDateString()}`,
    '',
    `## Summary`,
    `Total recurring spend tracked: $${totalAnnualized.toLocaleString()}/year across ${store.recurringProfiles.length} vendors`,
    `Active verbal approvals on file: ${store.approvals.filter(a => a.status === 'active').length}`,
    `Vendors needing formal contracts: ${store.recurringProfiles.filter(p => p.contractStatus === 'no_contract').length}`,
    '',
    '## High Priority — Formalize First',
    ...highPriority.map(p => `### ${p.vendorName}\n${p.procurementHandoffNote}`),
    '',
    '## Medium Priority',
    ...medPriority.map(p => `- **${p.vendorName}**: $${p.monthlyAmount.toLocaleString()}/mo. ${p.procurementHandoffNote}`),
    '',
    '## Approval Records on File',
    ...store.approvals
      .filter(a => a.status === 'active')
      .map(a => `- ${a.vendorName} $${a.amount} — approved by ${a.approvedBy} on ${a.approvalDate} via ${a.approvalMethod}`),
    '',
    '## Vendor Owner Map',
    ...Object.entries(store.vendorOwners).map(([vendor, owner]) => `- ${vendor}: ${owner}`),
  ].join('\n');
}
