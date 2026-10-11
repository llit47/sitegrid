import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validCommand } from '../apps/web/src/storage/progress-queue.js';
import { serializeSnapshot } from '../apps/server/src/project-snapshots/serialize.js';
import { validateSnapshot, OFFLINE_ACCESS_MS } from '../apps/web/src/storage/snapshot.js';
import type { ProjectSnapshotBody } from '../apps/server/src/project-snapshots/contract.js';

test('durable queue accepts the complete M08 payload and rejects incomplete/unsupported commands', () => {
  const command = { operationId: randomUUID(), schemaVersion: 1, action: 'start', expectedVersion: 1 };
  assert(validCommand(command)); assert(validCommand({ ...command, action: 'submit' }));
  for (const bad of [null, {}, { ...command, operationId: '' }, { ...command, schemaVersion: 2 }, { ...command, action: 'comment' },
    { ...command, expectedVersion: 0 }, { ...command, expectedVersion: 2147483647 }, { ...command, expectedVersion: 1.2 },
    { ...command, photos: [] }, { ...command, operationId: undefined }]) assert(!validCommand(bad));
});
test('snapshot progress permission is integrity-covered and old snapshots remain read-only', async () => {
  const scope = { accountId: randomUUID(), organizationId: randomUUID(), projectId: randomUUID() }, now = new Date().toISOString();
  const body: ProjectSnapshotBody = { format: 1, complete: true, scope, generatedAt: now, expiresAt: new Date(Date.parse(now) + OFFLINE_ACCESS_MS).toISOString(), taskAccess: 'own',
    project: { id: scope.projectId, name: 'Projekt', description: '', status: 'active', version: 1, createdAt: now, updatedAt: now, contractor: null },
    tasks: [{ id: randomUUID(), title: 'Zadanie', description: '', status: 'planned', version: 1, createdAt: now, updatedAt: now, assigneeName: null, canProgress: true }] };
  const snapshot = serializeSnapshot(body); assert.equal((await validateSnapshot(snapshot, scope)).tasks[0].canProgress, true);
  const tampered = structuredClone(snapshot); tampered.tasks[0].canProgress = false; await assert.rejects(validateSnapshot(tampered, scope));
  delete body.tasks[0].canProgress; assert.equal((await validateSnapshot(serializeSnapshot(body), scope)).tasks[0].canProgress, undefined);
  await assert.rejects(validateSnapshot(serializeSnapshot({ ...body, tasks: [{ ...body.tasks[0], canProgress: 'yes' as unknown as boolean }] }), scope));
});
