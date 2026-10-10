import { validateSnapshot, validUuid, OFFLINE_ACCESS_MS, type ProjectSnapshot } from './snapshot.js';
export const STORAGE_SCHEMA_VERSION = 2;
export type StorageScope = Readonly<{ accountId: string; organizationId: string; projectId: string }>;
export type StorageFailure = 'unavailable' | 'blocked' | 'quota' | 'aborted' | 'invalid' | 'failed' | 'expired' | 'stale';
export class LocalStorageError extends Error {
  constructor(public readonly code: StorageFailure) { super(`IndexedDB: ${code}`); }
}
export function storageFailure(error: unknown): LocalStorageError {
  if (error instanceof LocalStorageError) return error;
  const name = error instanceof DOMException ? error.name : '';
  return new LocalStorageError(name === 'QuotaExceededError' ? 'quota' : name === 'AbortError' ? 'aborted' :
    ['SecurityError', 'NotSupportedError'].includes(name) ? 'unavailable' : name === 'VersionError' ? 'invalid' : 'failed');
}
function canonicalScope(scope: StorageScope): StorageScope {
  const ids = [scope.accountId, scope.organizationId, scope.projectId];
  if (ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) throw new LocalStorageError('invalid');
  return Object.freeze({ accountId: ids[0].toLowerCase(), organizationId: ids[1].toLowerCase(), projectId: ids[2].toLowerCase() });
}
export function projectDatabaseName(scope: StorageScope): string {
  const owner = canonicalScope(scope);
  return `sitegrid-project-${owner.accountId}-${owner.organizationId}-${owner.projectId}`;
}
export function openLocalDatabase(name: string, version: number, upgrade: (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const fail = (error: unknown) => { abandoned = true; clearTimeout(timeout); reject(storageFailure(error)); };
    const timeout = setTimeout(() => fail(new LocalStorageError('blocked')), 5000);
    try {
      if (!globalThis.indexedDB) throw new LocalStorageError('unavailable');
      const request = indexedDB.open(name, version);
      request.onblocked = () => fail(new LocalStorageError('blocked'));
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = event => {
        if (abandoned) { request.transaction!.abort(); return; }
        request.transaction!.onerror = event => fail((event.target as IDBRequest).error);
        try { upgrade(request.result, request.transaction!, event.oldVersion); }
        catch (error) { request.transaction!.abort(); fail(error); }
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (abandoned) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    } catch (error) { fail(error); }
  });
}
// Work must enqueue requests synchronously. Resolve only after COMMIT, never on request success.
export function localTransaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, result: (value: T) => void, invalid: (error?: LocalStorageError) => void) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | undefined;
    let result: T;
    let rejected: LocalStorageError | undefined;
    try {
      tx = db.transaction(stores, mode);
      const cancel = () => { rejected = new LocalStorageError('aborted'); try { tx!.abort(); } catch { /* Already committed. */ } };
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      tx.oncomplete = () => { cleanup(); resolve(result); };
      tx.onabort = () => { cleanup(); reject(rejected ?? storageFailure(tx!.error ?? new DOMException('Aborted', 'AbortError'))); };
      tx.onerror = event => { rejected ??= storageFailure((event.target as IDBRequest).error ?? tx!.error); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      work(tx, value => { result = value; }, error => {
        rejected = error ?? new LocalStorageError('invalid'); tx!.abort();
      });
    } catch (error) {
      try { tx?.abort(); } catch { /* A completed transaction is already closed. */ }
      reject(storageFailure(error));
    }
  });
}
export function plainStore(db: IDBDatabase, name: string): boolean {
  if (!db.objectStoreNames.contains(name)) return false;
  const store = db.transaction(name).objectStore(name);
  return store.keyPath === null && !store.autoIncrement && store.indexNames.length === 0;
}
function ownerMatches(value: unknown, owner: StorageScope): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join() === 'accountId,format,organizationId,projectId' && record.format === 1 &&
    record.accountId === owner.accountId && record.organizationId === owner.organizationId && record.projectId === owner.projectId;
}
export type ConfirmedSnapshot = { format: 1; generation: string; authorizedAt: number; snapshot: ProjectSnapshot };
export async function openProjectStorage(scope: StorageScope, signal?: AbortSignal) {
  const owner = canonicalScope(scope);
  const db = await openLocalDatabase(projectDatabaseName(owner), STORAGE_SCHEMA_VERSION, (database, tx, oldVersion) => {
    if (oldVersion === 0 && database.objectStoreNames.length === 0) database.createObjectStore('metadata').put({ format: 1, ...owner }, 'owner');
    else if (oldVersion === 1 && database.objectStoreNames.contains('metadata') && !database.objectStoreNames.contains('confirmed')) {
      const metadata = tx.objectStore('metadata');
      if (metadata.keyPath !== null || metadata.autoIncrement || metadata.indexNames.length) throw new LocalStorageError('invalid');
      const request = metadata.get('owner'); request.onsuccess = () => { if (!ownerMatches(request.result, owner)) tx.abort(); };
    } else throw new LocalStorageError('invalid');
    // Only add our store. Future queue/draft stores are never deleted or cleared.
    database.createObjectStore('confirmed');
  });
  let closed = false;
  const close = () => { closed = true; db.close(); signal?.removeEventListener('abort', close); };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) { close(); throw new LocalStorageError('aborted'); }
  const check = () => {
    try {
      if (closed) throw new LocalStorageError('failed');
      if (!plainStore(db, 'metadata') || !plainStore(db, 'confirmed')) throw new LocalStorageError('invalid');
    }
    catch (error) { throw storageFailure(error); }
  };
  const readRaw = () => {
    check();
    return localTransaction<ConfirmedSnapshot | undefined>(db, ['metadata','confirmed'], 'readonly', (tx, result, invalid) => {
      const request = tx.objectStore('metadata').get('owner');
      request.onsuccess = () => { if (!ownerMatches(request.result, owner)) invalid(); };
      const snapshot = tx.objectStore('confirmed').get('snapshot'); snapshot.onsuccess = () => result(snapshot.result);
    }, signal);
  };
  const validateRecord = async (value: ConfirmedSnapshot) => {
    if (!value || Object.keys(value).sort().join() !== 'authorizedAt,format,generation,snapshot' || value.format !== 1 || !validUuid(value.generation) ||
      !Number.isFinite(value.authorizedAt) || value.authorizedAt <= 0) throw new LocalStorageError('invalid');
    try { await validateSnapshot(value.snapshot, owner); } catch { throw new LocalStorageError('invalid'); }
    return value;
  };
  const verify = async () => {
    const value = await readRaw(); if (value !== undefined) await validateRecord(value);
  };
  try { await verify(); }
  catch (error) { close(); throw storageFailure(error); }
  // A caller must close and discard this handle on logout or ANY scope change.
  return { verify, close,
    async read(generation: string): Promise<ConfirmedSnapshot | null> {
      const value = await readRaw(); if (value === undefined) return null;
      await validateRecord(value);
      if (value.generation !== generation) return null;
      if (Date.now() < value.authorizedAt || Date.now() >= value.authorizedAt + OFFLINE_ACCESS_MS) throw new LocalStorageError('expired');
      return value;
    },
    async replace(snapshot: unknown, generation: string, authorizedAt: number) {
      let valid: ProjectSnapshot;
      try { valid = await validateSnapshot(snapshot, owner); } catch { throw new LocalStorageError('invalid'); }
      if (!validUuid(generation) || !Number.isFinite(authorizedAt) || Date.now() < authorizedAt || Date.now() >= authorizedAt + OFFLINE_ACCESS_MS) throw new LocalStorageError('expired');
      const previous = await readRaw(); if (previous !== undefined) await validateRecord(previous);
      check();
      await localTransaction<void>(db, ['metadata','confirmed'], 'readwrite', (tx, result, invalid) => {
        const metadata = tx.objectStore('metadata').get('owner'); metadata.onsuccess = () => { if (!ownerMatches(metadata.result, owner)) invalid(); };
        const store = tx.objectStore('confirmed'), current = store.get('snapshot');
        current.onsuccess = () => {
          try {
            if (JSON.stringify(current.result) !== JSON.stringify(previous)) { invalid(); return; }
            if (current.result?.snapshot?.generatedAt >= valid.generatedAt) { invalid(new LocalStorageError('stale')); return; }
            store.put({ format: 1, generation, authorizedAt, snapshot: valid } satisfies ConfirmedSnapshot, 'snapshot'); result(undefined);
          } catch (error) { invalid(storageFailure(error)); }
        };
      }, signal);
    },
    async clear() { check(); await localTransaction<void>(db, ['confirmed'], 'readwrite', (tx, result) => { tx.objectStore('confirmed').delete('snapshot'); result(undefined); }, signal); },
  };
}
export async function checkLocalStorage(): Promise<void> {
  const db = await openLocalDatabase('sitegrid-idb-probe', 1, (database, _tx, oldVersion) => {
    if (oldVersion !== 0 || database.objectStoreNames.length !== 0) throw new LocalStorageError('invalid');
    database.createObjectStore('metadata');
  });
  try {
    if (!plainStore(db, 'metadata') || db.objectStoreNames.length !== 1) throw new LocalStorageError('invalid');
    await localTransaction<void>(db, ['metadata'], 'readwrite', (tx, result) => {
      const store = tx.objectStore('metadata');
      store.put(true, 'probe'); store.delete('probe'); result(undefined);
    });
  } catch (error) { throw storageFailure(error); }
  finally { db.close(); }
}
