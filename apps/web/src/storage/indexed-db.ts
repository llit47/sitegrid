// M09 stores only ownership metadata and a disposable capability probe.
export const STORAGE_SCHEMA_VERSION = 1;
export type StorageScope = Readonly<{ accountId: string; organizationId: string; projectId: string }>;
export type StorageFailure = 'unavailable' | 'blocked' | 'quota' | 'aborted' | 'invalid' | 'failed';
export class LocalStorageError extends Error {
  constructor(public readonly code: StorageFailure) { super(`IndexedDB: ${code}`); }
}
function failure(error: unknown): LocalStorageError {
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
function openDatabase(name: string, upgrade: (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const fail = (error: unknown) => { abandoned = true; clearTimeout(timeout); reject(failure(error)); };
    const timeout = setTimeout(() => fail(new LocalStorageError('blocked')), 5000);
    try {
      if (!globalThis.indexedDB) throw new LocalStorageError('unavailable');
      const request = indexedDB.open(name, STORAGE_SCHEMA_VERSION);
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
function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void, invalid: () => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | undefined;
    let result: T;
    let rejected: LocalStorageError | undefined;
    try {
      tx = db.transaction('metadata', mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(rejected ?? failure(tx!.error ?? new DOMException('Aborted', 'AbortError')));
      tx.onerror = event => { rejected ??= failure((event.target as IDBRequest).error ?? tx!.error); };
      work(tx.objectStore('metadata'), value => { result = value; }, () => {
        rejected = new LocalStorageError('invalid'); tx!.abort();
      });
    } catch (error) {
      try { tx?.abort(); } catch { /* A completed transaction is already closed. */ }
      reject(failure(error));
    }
  });
}
function validSchema(db: IDBDatabase): boolean {
  if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('metadata')) return false;
  const store = db.transaction('metadata').objectStore('metadata');
  return store.keyPath === null && !store.autoIncrement && store.indexNames.length === 0;
}
export async function openProjectStorage(scope: StorageScope) {
  const owner = canonicalScope(scope);
  const db = await openDatabase(projectDatabaseName(owner), (database, _tx, oldVersion) => {
    if (oldVersion !== 0 || database.objectStoreNames.length !== 0) throw new LocalStorageError('invalid');
    database.createObjectStore('metadata').put({ format: 1, ...owner }, 'owner');
  });
  const verify = async () => {
    try {
      if (!validSchema(db)) throw new LocalStorageError('invalid');
      await transaction<void>(db, 'readonly', (store, result, invalid) => {
        const request = store.get('owner');
        request.onsuccess = () => {
          const value = request.result;
          if (!value || Object.keys(value).sort().join() !== 'accountId,format,organizationId,projectId' || value.format !== 1 ||
              value.accountId !== owner.accountId || value.organizationId !== owner.organizationId || value.projectId !== owner.projectId) invalid();
          else result(undefined);
        };
      });
    } catch (error) { throw failure(error); }
  };
  try { await verify(); }
  catch (error) { db.close(); throw error; }
  // A caller must close and discard this handle on logout or ANY scope change.
  return { verify, close: () => db.close() };
}
export async function checkLocalStorage(): Promise<void> {
  const db = await openDatabase('sitegrid-idb-probe', (database, _tx, oldVersion) => {
    if (oldVersion !== 0 || database.objectStoreNames.length !== 0) throw new LocalStorageError('invalid');
    database.createObjectStore('metadata');
  });
  try {
    if (!validSchema(db)) throw new LocalStorageError('invalid');
    await transaction<void>(db, 'readwrite', (store, result) => {
      store.put(true, 'probe'); store.delete('probe'); result(undefined);
    });
  } catch (error) { throw failure(error); }
  finally { db.close(); }
}
