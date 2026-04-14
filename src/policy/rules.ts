/**
 * policy/rules.ts
 * Loads and validates the policy.yaml config.
 * All agent decision logic reads from this module — not hardcoded values.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ── Schema ────────────────────────────────────────────────────────────────────

const PolicySchema = z.object({
  version: z.string(),
  limits: z.object({
    auto_approve_under: z.number(),
    flag_for_review_over: z.number(),
    require_receipt_over: z.number(),
  }),
  categories: z.object({
    allowed: z.array(z.string()),
    always_flag: z.array(z.string()),
  }),
  human_in_loop: z.object({
    enabled: z.boolean(),
    require_approval_for_flags: z.boolean(),
    timeout_minutes: z.number(),
    notify_email: z.string().optional(),
  }),
  escalation: z.object({
    vendor_flag_threshold: z.number(),
    total_flagged_spend_threshold: z.number(),
    escalation_target: z.string().optional(),
  }),
  caching: z.object({
    enabled: z.boolean(),
    ttl_hours: z.number(),
  }),
});

export type Policy = z.infer<typeof PolicySchema>;

// ── Loader ────────────────────────────────────────────────────────────────────

let _policy: Policy | null = null;

export function loadPolicy(configPath?: string): Policy {
  if (_policy) return _policy;

  const resolvedPath = configPath ?? path.resolve(process.cwd(), 'config/policy.yaml');
  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw);
  _policy = PolicySchema.parse(parsed);
  return _policy;
}

// ── Decision helpers ─────────────────────────────────────────────────────────

export type ExpenseDecision = 'auto_approve' | 'flag' | 'escalate';

export interface ExpenseItem {
  amount: number;
  category: string;
  hasReceipt: boolean;
  vendor?: string;
  description?: string;
}

export function evaluateExpense(
  item: ExpenseItem,
  policy: Policy
): { decision: ExpenseDecision; reason: string } {
  const { amount, category, hasReceipt } = item;
  const normalizedCategory = category.toLowerCase().trim();

  // Always-flag categories override everything
  if (policy.categories.always_flag.some(c => normalizedCategory.includes(c))) {
    return {
      decision: 'flag',
      reason: `Category "${category}" is always flagged per policy.`,
    };
  }

  // Missing receipt when required
  if (!hasReceipt && amount >= policy.limits.require_receipt_over) {
    return {
      decision: 'flag',
      reason: `Missing receipt for $${amount} expense (required for amounts over $${policy.limits.require_receipt_over}).`,
    };
  }

  // High-value — escalate
  if (amount >= policy.limits.flag_for_review_over) {
    return {
      decision: 'flag',
      reason: `Amount $${amount} meets or exceeds the $${policy.limits.flag_for_review_over} review threshold.`,
    };
  }

  // Category not in allowed list
  const isAllowedCategory = policy.categories.allowed.some(c =>
    normalizedCategory.includes(c)
  );
  if (!isAllowedCategory) {
    return {
      decision: 'flag',
      reason: `Category "${category}" is not in the approved categories list.`,
    };
  }

  // All checks pass — auto-approve
  if (amount < policy.limits.auto_approve_under) {
    return {
      decision: 'auto_approve',
      reason: `Under $${policy.limits.auto_approve_under} threshold, valid category, receipt present.`,
    };
  }

  // Middle ground — flag for review
  return {
    decision: 'flag',
    reason: `Amount $${amount} is above auto-approve threshold ($${policy.limits.auto_approve_under}) but below escalation threshold.`,
  };
}
