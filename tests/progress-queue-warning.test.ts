import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { queueRecovered } from '../apps/web/src/progress/queue-ui.js';
import type { QueueState } from '../apps/web/src/progress/queue-state.js';
import type { QueuedProgress } from '../apps/web/src/storage/progress-queue.js';
const accountId = randomUUID();
const scope = { accountId, organizationId:randomUUID(), projectId:randomUUID() };
const healthy = (): QueueState => ({ accountId, access:{format:1,accountId,generation:randomUUID(),scopes:[scope],clock:Date.now()},
  rows:[{scope,state:'confirmed'} as QueuedProgress], failures:[], checking:false, failed:false });

test('failure then recovery clears warnings only after a healthy confirmed read', () => {
  const state=healthy();state.failed=true;assert(!queueRecovered(state,accountId));
  state.failed=false;state.rows[0].state='pending';assert(!queueRecovered(state,accountId));
  state.rows[0].state='confirmed';assert(queueRecovered(state,accountId));
  assert(queueRecovered({...state,rows:[]},accountId),'An empty recovered queue clears an old warning');
});
test('unresolved storage, partition and operation failures keep warnings; unverified/account-mismatched reads cannot clear them', () => {
  const state=healthy();
  for(const failed of [{...state,failed:true},{...state,failures:[scope]},
    {...state,rows:[{...state.rows[0],state:'attention' as const}]},{...state,checking:true},{...state,access:null},
    {...state,accountId:randomUUID()},{...state,access:{...state.access!,accountId:randomUUID()}}]) assert(!queueRecovered(failed,accountId));
});
test('recovery in one project cannot clear warnings for another broken partition', () => {
  const state=healthy(), other={...scope,projectId:randomUUID()};
  state.failures=[scope,other];assert(!queueRecovered(state,accountId));
  state.failures=[other];assert(!queueRecovered(state,accountId));
  state.failures=[];assert(queueRecovered(state,accountId));
});
