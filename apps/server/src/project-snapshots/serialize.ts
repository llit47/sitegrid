import { createHash } from 'node:crypto';
import { canonicalJson, snapshotRecords, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_TASKS, type ProjectSnapshotBody, type ProjectSnapshot } from './contract.js';
export class SnapshotLimitError extends Error {
  constructor() { super('Projekt przekracza limit przygotowania offline (500 zadań lub 2 MiB). Nie zapisano niepełnych danych.'); }
}

export function serializeSnapshot(body: ProjectSnapshotBody): ProjectSnapshot {
  const encoded = canonicalJson(body);
  const snapshot: ProjectSnapshot = { ...body, integrity: { algorithm: 'SHA-256', digest: createHash('sha256').update(encoded).digest('hex'), records: snapshotRecords(body), bytes: Buffer.byteLength(encoded) } };
  if (body.tasks.length > MAX_SNAPSHOT_TASKS || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotLimitError();
  }
  return snapshot;
}
