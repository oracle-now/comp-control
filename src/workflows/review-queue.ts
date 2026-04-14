/**
 * workflows/review-queue.ts
 * Manages the file-based review queue that the human-in-loop dashboard reads.
 *
 * Queue lives at: ./review-queue/pending.json
 * Completed reviews move to: ./review-queue/resolved.json
 *
 * resolved.json structure:
 *   {
 *     "items":     ReviewItem[]     — human-resolved flagged items (existing)
 *     "runAudits": RunJudgement[]   — per-run JudgementResult records (new)
 *   }
 *
 * Keeping both arrays in the same file means one read gives you the full
 * picture of a run: what was flagged + how the run itself was judged.
 */

import fs from 'fs';
import path from 'path';
import type { JudgementResult } from '../memory/judge-run.js';

const QUEUE_DIR = path.resolve(process.cwd(), 'review-queue');
const PENDING_FILE = path.join(QUEUE_DIR, 'pending.json');
const RESOLVED_FILE = path.join(QUEUE_DIR, 'resolved.json');

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ReviewItem {
  id: string;
  vendor: string;
  amount: number;
  category: string;
  hasReceipt: boolean;
  flagReason: string;
  decision: 'flag' | 'escalate';
  timestamp: string;
  humanDecision?: 'approve' | 'reject' | 'escalate';
  humanNote?: string;
  resolvedAt?: string;
}

/**
 * A run-level audit record written to resolved.json after every workflow run.
 * Contains the JudgementResult plus a unique runId for cross-referencing logs.
 */
export interface RunJudgement {
  /** Unique run identifier — ISO timestamp + random suffix */
  runId: string;
  judgement: JudgementResult;
  /** ISO timestamp of when this record was written */
  writtenAt: string;
}

/**
 * The shape of resolved.json on disk.
 * Using a wrapper object (not a bare array) lets us add new top-level keys
 * without a migration — e.g. a future 'policySnapshots' array.
 */
interface ResolvedFile {
  items: ReviewItem[];
  runAudits: RunJudgement[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function ensureQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function readResolvedFile(): ResolvedFile {
  if (!fs.existsSync(RESOLVED_FILE)) return { items: [], runAudits: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(RESOLVED_FILE, 'utf-8')) as unknown;
    // Handle legacy format: if the file was a bare ReviewItem[] array,
    // migrate it transparently to the new object shape.
    if (Array.isArray(raw)) {
      return { items: raw as ReviewItem[], runAudits: [] };
    }
    const obj = raw as Partial<ResolvedFile>;
    return {
      items: obj.items ?? [],
      runAudits: obj.runAudits ?? [],
    };
  } catch {
    return { items: [], runAudits: [] };
  }
}

function writeResolvedFile(data: ResolvedFile): void {
  ensureQueueDir();
  fs.writeFileSync(RESOLVED_FILE, JSON.stringify(data, null, 2));
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function writeToReviewQueue(item: ReviewItem): Promise<void> {
  ensureQueueDir();
  const existing = readPendingQueue();
  const updated = [...existing.filter(i => i.id !== item.id), item];
  fs.writeFileSync(PENDING_FILE, JSON.stringify(updated, null, 2));
}

export function readPendingQueue(): ReviewItem[] {
  ensureQueueDir();
  if (!fs.existsSync(PENDING_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')) as ReviewItem[];
  } catch {
    return [];
  }
}

export async function resolveQueueItem(
  id: string,
  humanDecision: ReviewItem['humanDecision'],
  humanNote?: string
): Promise<void> {
  const pending = readPendingQueue();
  const item = pending.find(i => i.id === id);
  if (!item) throw new Error(`Item ${id} not found in pending queue`);

  const resolved: ReviewItem = {
    ...item,
    humanDecision,
    humanNote,
    resolvedAt: new Date().toISOString(),
  };

  const data = readResolvedFile();
  data.items = [...data.items.filter(i => i.id !== id), resolved];
  writeResolvedFile(data);

  const updatedPending = pending.filter(i => i.id !== id);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(updatedPending, null, 2));
}

export function readResolvedQueue(): ReviewItem[] {
  return readResolvedFile().items;
}

export function readRunAudits(): RunJudgement[] {
  return readResolvedFile().runAudits;
}

/**
 * Append a RunJudgement to the runAudits array in resolved.json.
 * Called by the agent after judgeRun() completes.
 *
 * Thread-safety note: this is a read-modify-write on a local file.
 * For a single-process agent this is fine. If you ever run concurrent
 * agents against the same queue dir, replace with an append-only JSONL
 * file and a write lock.
 */
export function writeRunJudgement(judgement: JudgementResult): RunJudgement {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;

  const record: RunJudgement = {
    runId,
    judgement,
    writtenAt: new Date().toISOString(),
  };

  const data = readResolvedFile();
  data.runAudits = [...data.runAudits, record];
  writeResolvedFile(data);

  return record;
}
