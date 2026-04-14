/**
 * workflows/review-queue.ts
 * Manages the file-based review queue that the human-in-loop dashboard reads.
 *
 * Queue lives at: ./review-queue/pending.json
 * Completed reviews move to: ./review-queue/resolved.json
 *
 * This is intentionally simple — no database, no external service.
 * A future version could write to Slack, Linear, or a webhook instead.
 */

import fs from 'fs';
import path from 'path';

const QUEUE_DIR = path.resolve(process.cwd(), 'review-queue');
const PENDING_FILE = path.join(QUEUE_DIR, 'pending.json');
const RESOLVED_FILE = path.join(QUEUE_DIR, 'resolved.json');

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

function ensureQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

export async function writeToReviewQueue(item: ReviewItem): Promise<void> {
  ensureQueueDir();
  const existing = readPendingQueue();
  // Deduplicate by id
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

  // Write to resolved
  const resolvedList = readResolvedQueue();
  fs.writeFileSync(
    RESOLVED_FILE,
    JSON.stringify([...resolvedList, resolved], null, 2)
  );

  // Remove from pending
  const updatedPending = pending.filter(i => i.id !== id);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(updatedPending, null, 2));
}

export function readResolvedQueue(): ReviewItem[] {
  if (!fs.existsSync(RESOLVED_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(RESOLVED_FILE, 'utf-8')) as ReviewItem[];
  } catch {
    return [];
  }
}
