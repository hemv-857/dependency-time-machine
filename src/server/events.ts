import type { SnapshotRow } from './store/index';
import { SnapshotStatus, Stage } from '@/core/types';

type Listener = (event: string, data: unknown) => void;

interface Registry {
  emitters: Map<string, Set<Listener>>;
  lastPayload: Map<string, { status: SnapshotStatus; row: SnapshotRow }>;
}

const globalForEvents = globalThis as unknown as { __tmEvents?: Registry };

function reg(): Registry {
  if (!globalForEvents.__tmEvents) {
    globalForEvents.__tmEvents = { emitters: new Map(), lastPayload: new Map() };
  }
  return globalForEvents.__tmEvents;
}

export function publish(snapshotId: string, event: string, data: unknown): void {
  const set = reg().emitters.get(snapshotId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event, data);
    } catch {
      /* listener died; SSE route cleans up */
    }
  }
}

export function publishStage(snapshotId: string, stages: Stage[], status: SnapshotStatus): void {
  publish(snapshotId, 'stage', { stages, status });
}

export function subscribe(snapshotId: string, fn: Listener): () => void {
  const set = reg().emitters.get(snapshotId) || new Set();
  set.add(fn);
  reg().emitters.set(snapshotId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) reg().emitters.delete(snapshotId);
  };
}

/** Remember the latest full row so late SSE subscribers can catch up instantly. */
export function setLastPayload(snapshotId: string, row: SnapshotRow): void {
  reg().lastPayload.set(snapshotId, { status: row.status, row });
}

export function getLastPayload(snapshotId: string): SnapshotRow | null {
  return reg().lastPayload.get(snapshotId)?.row || null;
}

export function clearLastPayload(snapshotId: string): void {
  reg().lastPayload.delete(snapshotId);
}
