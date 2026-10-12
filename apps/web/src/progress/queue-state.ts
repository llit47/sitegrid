import { readOfflineAccess } from '../storage/offline-access.js';
import type { StorageScope } from '../storage/indexed-db.js';
import type { QueuedProgress } from '../storage/progress-queue.js';
import { accountQueue, progressEvent } from './sync.js';

type Access = Awaited<ReturnType<typeof readOfflineAccess>>;
export type QueueState = { accountId: string | null; access: Access; rows: QueuedProgress[]; failures: StorageScope[]; checking: boolean; failed: boolean };
const empty = (): QueueState => ({ accountId: null, access: null, rows: [], failures: [], checking: true, failed: false });
const sameScope = (a: StorageScope, b: StorageScope) => a.accountId === b.accountId && a.organizationId === b.organizationId && a.projectId === b.projectId;

// One reader per tab/account, independent of task-card count. Events refresh it;
// a slow fallback also covers browsers without BroadcastChannel and expired leases.
export function createQueueState({ readAccess = readOfflineAccess, readQueues = accountQueue, watch = watchQueue } = {}) {
  let value = empty(), accountId: string | null = null, epoch = 0, running = false, dirty = false, scheduled = false;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const publish = (next: QueueState) => { value = next; listeners.forEach(listener => listener()); };
  const refresh = async () => {
    if (running) { dirty = true; return; }
    running = true; const currentEpoch = epoch, expected = accountId;
    try {
      const access = await readAccess(), owner = expected ?? access?.accountId ?? null;
      if (expected && access && access.accountId !== expected) {
        if (currentEpoch === epoch) publish({ ...empty(), accountId: expected, checking: false, failed: true });
        return;
      }
      if (!access || (expected && access.accountId !== expected)) throw new Error('Local access unavailable');
      const queues = await readQueues(access.accountId), current = await readAccess();
      if (currentEpoch !== epoch) return;
      if (!current || current.accountId !== owner || current.generation !== access.generation) throw new Error('Account changed');
      const retained = value.accountId === owner ? value.rows.filter(row => queues.failures.some(scope => sameScope(scope, row.scope))) : [];
      publish({ accountId: owner, access: current, rows: [...queues.rows, ...retained], failures: queues.failures, checking: false, failed: false });
    } catch {
      if (currentEpoch === epoch) publish({ ...value, accountId: expected ?? value.accountId, access: null, checking: false, failed: true });
    } finally {
      running = false;
      if (dirty) { dirty = false; schedule(); }
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; if (listeners.size) void refresh(); });
  };
  const invalidate = () => {
    epoch++;
    publish({ ...value, access: null, failed: true }); // Hide titles immediately on an access fence.
    schedule();
  };
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) { stop = watch(schedule, invalidate); schedule(); }
      return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; epoch++; } };
    },
    bindAccount(owner: string) {
      accountId = owner; epoch++; publish({ ...empty(), accountId: owner }); schedule();
      return () => { if (accountId === owner) { accountId = null; epoch++; publish(empty()); schedule(); } };
    },
  };
}
function watchQueue(wake: () => void, invalidate: () => void) {
  const visible = () => { if (document.visibilityState === 'visible') wake(); };
  const timer = window.setInterval(visible, 15_000);
  window.addEventListener(progressEvent, wake); window.addEventListener('sitegrid-offline-access', invalidate);
  window.addEventListener('online', wake); document.addEventListener('visibilitychange', visible);
  return () => {
    clearInterval(timer); window.removeEventListener(progressEvent, wake); window.removeEventListener('sitegrid-offline-access', invalidate);
    window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', visible);
  };
}
export const queueState = createQueueState();
