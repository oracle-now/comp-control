/**
 * career/bottleneck-log.ts
 *
 * Structured log for everything that slows you down or goes wrong.
 *
 * Two purposes:
 *   1. YOUR working memory — log it and forget it. The system remembers.
 *      No more keeping mental tabs on "Marcus still hasn't responded"
 *      or "Ramp's export was broken again this week."
 *
 *   2. CYA documentation — when someone asks why something was late,
 *      or why a charge slipped through, you have a timestamped record
 *      of exactly what blocked you and when you flagged it.
 *
 * Bottleneck types:
 *   PEOPLE_UNRESPONSIVE   — cardholder/manager not responding to comments
 *   PEOPLE_ESCALATION     — someone pushed back on a policy call you made
 *   SYSTEM_ERROR          — Ramp, Slack, or the agent itself broke
 *   PROCESS_GAP           — there's no process for this, you had to wing it
 *   MISSING_DATA          — you needed info that doesn't exist anywhere
 *   ACCESS_BLOCKED        — you don't have permissions you need
 *   APPROVAL_DELAY        — waiting on someone above you to approve something
 *   EXTERNAL_VENDOR       — vendor not responding, wrong bill, dispute in progress
 *
 * Triage levels mirror incident severity:
 *   P1 — blocking close or causing financial risk right now
 *   P2 — will become a P1 if not resolved in 48h
 *   P3 — annoying but not time-critical
 *   P4 — log it for the process improvement conversation later
 */

import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type BottleneckType =
  | 'PEOPLE_UNRESPONSIVE'
  | 'PEOPLE_ESCALATION'
  | 'SYSTEM_ERROR'
  | 'PROCESS_GAP'
  | 'MISSING_DATA'
  | 'ACCESS_BLOCKED'
  | 'APPROVAL_DELAY'
  | 'EXTERNAL_VENDOR';

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type BottleneckStatus = 'open' | 'in_progress' | 'resolved' | 'escalated' | 'accepted';

export interface BottleneckEntry {
  id: string;
  loggedAt: string;           // ISO timestamp
  type: BottleneckType;
  priority: Priority;
  status: BottleneckStatus;
  title: string;              // one-line summary
  detail: string;             // full context
  blockedBy?: string;         // person, system, or team name
  impactedTransactions?: string[];  // transaction IDs if applicable
  dollarAtRisk?: number;      // estimated dollar impact if unresolved
  firstFollowUpAt?: string;   // when you first flagged this to someone
  resolvedAt?: string;
  resolutionNote?: string;
  /**
   * CYA summary — what you did, when, who you told.
   * Auto-generated from the log history.
   * Use this verbatim if you ever need to explain what happened.
   */
  cyaSummary: string;
  updates: BottleneckUpdate[];
}

export interface BottleneckUpdate {
  timestamp: string;
  note: string;
  statusChange?: BottleneckStatus;
}

// ── Storage ───────────────────────────────────────────────────────────────

const LOG_PATH = path.resolve(process.cwd(), 'data/bottlenecks.json');

function loadLog(): BottleneckEntry[] {
  try {
    if (fs.existsSync(LOG_PATH)) return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
  } catch { /* ignore */ }
  return [];
}

function saveLog(entries: BottleneckEntry[]): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

function generateId(): string {
  return `btl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function generateCYA(entry: Omit<BottleneckEntry, 'id' | 'cyaSummary' | 'updates'>): string {
  const dateStr = new Date(entry.loggedAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const blockedPhrase = entry.blockedBy ? ` blocked by ${entry.blockedBy}` : '';
  const dollarPhrase = entry.dollarAtRisk ? ` with $${entry.dollarAtRisk.toLocaleString()} at risk` : '';
  const followUpPhrase = entry.firstFollowUpAt
    ? ` First follow-up sent ${new Date(entry.firstFollowUpAt).toLocaleDateString()}.`
    : ' No follow-up required yet.';

  return `On ${dateStr}, logged ${entry.priority} ${entry.type.replace(/_/g, ' ').toLowerCase()}${blockedPhrase}${dollarPhrase}: "${entry.title}".${followUpPhrase} Status: ${entry.status}.`;
}

// ── Core functions ─────────────────────────────────────────────────────────

export function logBottleneck(
  params: Omit<BottleneckEntry, 'id' | 'cyaSummary' | 'updates' | 'loggedAt' | 'status'>
  & { status?: BottleneckStatus }
): BottleneckEntry {
  const entries = loadLog();
  const now = new Date().toISOString();

  const partial = {
    ...params,
    loggedAt: now,
    status: params.status ?? 'open' as BottleneckStatus,
  };

  const entry: BottleneckEntry = {
    ...partial,
    id: generateId(),
    cyaSummary: generateCYA(partial),
    updates: [],
  };

  entries.unshift(entry);
  saveLog(entries);

  const emoji = { P1: '🚨', P2: '⚠️', P3: '🟡', P4: 'ℹ️' }[entry.priority];
  log.warn(`[${emoji} Bottleneck] ${entry.priority} ${entry.type}: ${entry.title}`);

  return entry;
}

export function updateBottleneck(
  id: string,
  update: {
    note: string;
    statusChange?: BottleneckStatus;
    resolvedAt?: string;
    resolutionNote?: string;
  }
): BottleneckEntry | null {
  const entries = loadLog();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return null;

  const entry = entries[idx]!;
  entry.updates.push({
    timestamp: new Date().toISOString(),
    note: update.note,
    statusChange: update.statusChange,
  });

  if (update.statusChange) entry.status = update.statusChange;
  if (update.resolvedAt) entry.resolvedAt = update.resolvedAt;
  if (update.resolutionNote) entry.resolutionNote = update.resolutionNote;

  // Regenerate CYA with updated status
  entry.cyaSummary = generateCYA(entry);
  if (entry.updates.length > 0) {
    entry.cyaSummary += ` Updates: ${entry.updates.map(u => `[${new Date(u.timestamp).toLocaleDateString()}] ${u.note}`).join('; ')}.`;
  }

  entries[idx] = entry;
  saveLog(entries);
  return entry;
}

export function getOpenBottlenecks(
  minPriority: Priority = 'P4'
): BottleneckEntry[] {
  const priorityRank: Record<Priority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
  const minRank = priorityRank[minPriority];
  return loadLog().filter(
    e => e.status !== 'resolved' && priorityRank[e.priority] <= minRank
  );
}

/**
 * Auto-escalate P1 bottlenecks that have been open more than N hours.
 * Returns entries that need human attention.
 */
export function getStaleBottlenecks(maxAgeHours = 24): BottleneckEntry[] {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  return loadLog().filter(
    e =>
      e.status !== 'resolved' &&
      e.priority === 'P1' &&
      new Date(e.loggedAt).getTime() < cutoff
  );
}

/**
 * Export a CYA report for a date range.
 * Use this when you need to explain what happened in a given period.
 */
export function exportCYAReport(
  fromDate: string,
  toDate: string
): { entries: BottleneckEntry[]; reportText: string } {
  const entries = loadLog().filter(
    e => e.loggedAt >= fromDate && e.loggedAt <= toDate
  );

  const reportText = [
    `AP Bottleneck Report: ${fromDate.split('T')[0]} – ${toDate.split('T')[0]}`,
    `Total issues logged: ${entries.length}`,
    `P1: ${entries.filter(e => e.priority === 'P1').length} | P2: ${entries.filter(e => e.priority === 'P2').length} | P3: ${entries.filter(e => e.priority === 'P3').length} | P4: ${entries.filter(e => e.priority === 'P4').length}`,
    `Resolved: ${entries.filter(e => e.status === 'resolved').length} | Still open: ${entries.filter(e => e.status !== 'resolved').length}`,
    '',
    ...entries.map(e => `• ${e.cyaSummary}`),
  ].join('\n');

  return { entries, reportText };
}
