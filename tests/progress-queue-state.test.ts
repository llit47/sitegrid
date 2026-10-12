import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createQueueState } from '../apps/web/src/progress/queue-state.js';
import type { QueuedProgress } from '../apps/web/src/storage/progress-queue.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
const accessFor = (accountId: string) => ({ format: 1 as const, accountId, generation: randomUUID(), scopes: [], clock: Date.now() });

test('one shared queue read serves one or 100 task subscriptions; events refresh and cleanup stops the watcher', async () => {
  for (const count of [1,100]) {
    let reads = 0, accessReads = 0, watches = 0, stopped = 0, wake = () => {};
    const access = accessFor(randomUUID());
    const store = createQueueState({ readAccess: async () => { accessReads++; return access; },
      readQueues: async () => { reads++; return { rows: [], failures: [] }; },
      watch: callback => { watches++; wake = callback; return () => { stopped++; }; } });
    const unbind = store.bindAccount(access.accountId);
    const subscriptions = Array.from({ length: count }, () => store.subscribe(() => {}));
    await flush(); assert.equal(reads,1); assert.equal(accessReads,2); assert.equal(watches,1);
    wake(); wake(); await flush(); assert.equal(reads,2); assert.equal(accessReads,4);
    subscriptions.forEach(stop => stop()); assert.equal(stopped,1); unbind();
  }
});
test('queue state keeps known pending commands on storage failure and fences delayed reads after account change', async () => {
  const a = accessFor(randomUUID()), b = accessFor(randomUUID());
  const scope = { accountId:a.accountId, organizationId:randomUUID(), projectId:randomUUID() };
  const row = { scope, taskId:randomUUID(), state:'pending' } as QueuedProgress;
  let access = a, failed = false, wake = () => {}, release = () => {};
  let held: Promise<void> | null = null;
  const store = createQueueState({ readAccess: async () => { if(failed) throw new Error('Storage unavailable'); return access; },
    readQueues: async accountId => { if(held) await held; return { rows:accountId===a.accountId ? [row] : [], failures:[] }; },
    watch: callback => { wake = callback; return () => {}; } });
  const stop = store.subscribe(() => {}), unbind = store.bindAccount(a.accountId);
  await flush(); assert.deepEqual(store.getSnapshot().rows,[row]);
  failed = true; wake(); await flush(); assert.equal(store.getSnapshot().failed,true); assert.deepEqual(store.getSnapshot().rows,[row]);
  failed = false; access = b; wake(); await flush(); assert.deepEqual(store.getSnapshot().rows,[]);
  access = a; held = new Promise(resolve => { release=resolve; }); wake(); await flush();
  unbind(); access = b; const unbindB = store.bindAccount(b.accountId); release(); held = null;
  await flush(); await flush(); assert.equal(store.getSnapshot().accountId,b.accountId); assert.deepEqual(store.getSnapshot().rows,[]);
  stop(); unbindB();
});
