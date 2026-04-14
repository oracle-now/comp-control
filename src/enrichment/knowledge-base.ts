/**
 * enrichment/knowledge-base.ts
 *
 * The "institutional knowledge" layer — the thing that makes this feel
 * like a senior accountant who's been at the company for two years,
 * not a policy rules engine.
 *
 * A rules engine knows: "this charge is over $500, flag it."
 * An accountant knows: "AWS charges spike at month-end because of reserved
 * instance billing cycles. That $2,400 is normal. But this $180 at a
 * restaurant on a Saturday is unusual for Sarah's role as an SDR."
 *
 * This module loads that institutional memory from knowledge.yaml and
 * exposes it to the enrichment engine as structured context.
 *
 * knowledge.yaml lives at config/knowledge.yaml and is NOT committed
 * with real data — see config/knowledge.example.yaml for the schema.
 *
 * Three knowledge types:
 *   VendorPattern    — known vendors with expected charge ranges + notes
 *   EmployeeContext  — roles and typical spend patterns per employee/team
 *   MonthEndRule     — special rules that only apply during close window
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ── Schemas ──────────────────────────────────────────────────────────────

const VendorPatternSchema = z.object({
  /** Partial vendor name match (case-insensitive) */
  namePattern: z.string(),
  /** Expected monthly charge range in dollars */
  expectedMin: z.number().optional(),
  expectedMax: z.number().optional(),
  /** Free-text note visible to the LLM — the institutional context */
  note: z.string(),
  /** If true, charges within range are pre-cleared — skip question generation */
  preCleared: z.boolean().default(false),
  /** Categories this vendor typically maps to */
  expectedCategories: z.array(z.string()).default([]),
});

const EmployeeContextSchema = z.object({
  /** Exact name or email prefix match */
  identifier: z.string(),
  role: z.string(),
  team: z.string(),
  /** What kinds of charges are normal for this person */
  typicalSpend: z.array(z.string()),
  /** What would be unusual and warrants a question */
  flagIfSees: z.array(z.string()).default([]),
  /** Monthly soft limit — alert if a single charge exceeds this */
  softLimitPerCharge: z.number().optional(),
});

const MonthEndRuleSchema = z.object({
  /** Which days of the month this rule is active (1-31) */
  activeDays: z.array(z.number()),
  description: z.string(),
  /** Additional flag threshold during close — overrides policy.yaml */
  overrideFlagThreshold: z.number().optional(),
  /** Require receipts for ALL charges during close, regardless of amount */
  requireAllReceipts: z.boolean().default(false),
});

const KnowledgeBaseSchema = z.object({
  version: z.string().default('1'),
  companyName: z.string().default(''),
  /** 1-3 sentence description of the business — gives the LLM domain context */
  businessContext: z.string().default(''),
  vendors: z.array(VendorPatternSchema).default([]),
  employees: z.array(EmployeeContextSchema).default([]),
  monthEndRules: z.array(MonthEndRuleSchema).default([]),
  /**
   * Free-form institutional notes — anything that doesn't fit the above.
   * E.g. "We expense Uber only for client visits, not commutes."
   * E.g. "Marketing team has a standing $500/mo Canva subscription on John's card."
   */
  notes: z.array(z.string()).default([]),
});

export type VendorPattern = z.infer<typeof VendorPatternSchema>;
export type EmployeeContext = z.infer<typeof EmployeeContextSchema>;
export type MonthEndRule = z.infer<typeof MonthEndRuleSchema>;
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

// ── Loader ─────────────────────────────────────────────────────────────────

let _kb: KnowledgeBase | null = null;

export function loadKnowledgeBase(configPath?: string): KnowledgeBase {
  if (_kb) return _kb;

  const resolvedPath =
    configPath ??
    path.resolve(process.cwd(), 'config/knowledge.yaml');

  if (!fs.existsSync(resolvedPath)) {
    // Knowledge base is optional — return empty defaults if file doesn't exist
    _kb = KnowledgeBaseSchema.parse({});
    return _kb;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw);
  _kb = KnowledgeBaseSchema.parse(parsed);
  return _kb;
}

// ── Lookup helpers ────────────────────────────────────────────────────────

export function matchVendor(
  vendorName: string,
  kb: KnowledgeBase
): VendorPattern | null {
  const lower = vendorName.toLowerCase();
  return (
    kb.vendors.find(v => lower.includes(v.namePattern.toLowerCase())) ?? null
  );
}

export function matchEmployee(
  nameOrEmail: string,
  kb: KnowledgeBase
): EmployeeContext | null {
  const lower = nameOrEmail.toLowerCase();
  return (
    kb.employees.find(e => lower.includes(e.identifier.toLowerCase())) ?? null
  );
}

export function getActiveMonthEndRules(
  dayOfMonth: number,
  kb: KnowledgeBase
): MonthEndRule[] {
  return kb.monthEndRules.filter(r => r.activeDays.includes(dayOfMonth));
}

/**
 * Serialize the knowledge base into a compact string for LLM injection.
 * Keeps the prompt focused — only includes relevant entries for the
 * specific vendor and employee in the current transaction.
 */
export function buildKnowledgeContext(
  vendorName: string,
  cardholderName: string,
  dayOfMonth: number,
  kb: KnowledgeBase
): string {
  const parts: string[] = [];

  if (kb.businessContext) {
    parts.push(`Company context: ${kb.businessContext}`);
  }

  const vendor = matchVendor(vendorName, kb);
  if (vendor) {
    parts.push(
      `Known vendor "${vendorName}": ${vendor.note}` +
      (vendor.expectedMin !== undefined && vendor.expectedMax !== undefined
        ? ` Expected charge range: $${vendor.expectedMin}–$${vendor.expectedMax}.`
        : '') +
      (vendor.preCleared ? ' Pre-cleared — no question needed if within range.' : '') +
      (vendor.expectedCategories.length > 0
        ? ` Typical categories: ${vendor.expectedCategories.join(', ')}.`
        : '')
    );
  }

  const employee = matchEmployee(cardholderName, kb);
  if (employee) {
    parts.push(
      `Cardholder "${cardholderName}" is a ${employee.role} on the ${employee.team} team. ` +
      `Typical spend: ${employee.typicalSpend.join(', ')}.` +
      (employee.flagIfSees.length > 0
        ? ` Unusual for this role: ${employee.flagIfSees.join(', ')}.`
        : '') +
      (employee.softLimitPerCharge !== undefined
        ? ` Soft limit per charge: $${employee.softLimitPerCharge}.`
        : '')
    );
  }

  const monthEndRules = getActiveMonthEndRules(dayOfMonth, kb);
  if (monthEndRules.length > 0) {
    parts.push(
      `Month-end close rules active today (day ${dayOfMonth}): ` +
      monthEndRules.map(r => r.description).join('; ')
    );
  }

  if (kb.notes.length > 0) {
    parts.push(`Institutional notes:\n${kb.notes.map(n => `  - ${n}`).join('\n')}`);
  }

  return parts.length > 0 ? parts.join('\n\n') : '(No institutional knowledge available for this transaction)';
}
