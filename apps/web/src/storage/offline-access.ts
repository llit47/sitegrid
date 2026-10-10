import { openLocalDatabase, localTransaction, plainStore, LocalStorageError, storageFailure, type StorageScope, openProjectStorage } from './indexed-db.js';
import { validUuid } from './snapshot.js';

// A nonsensitive denial flag survives an IDB failure. It carries no identity/data
// and never grants access; only a verified online session can remove it.
const denialCookie = 'sitegrid-offline-denied';
let deniedInMemory = false;
export function offlineAccessDenied() { return deniedInMemory || document.cookie.split(';').some(item => item.trim() === `${denialCookie}=1`); }
export function denyOfflineAccess() {
  deniedInMemory = true;
  document.cookie = `${denialCookie}=1; Path=/; SameSite=Strict; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`;
  window.dispatchEvent(new Event('sitegrid-offline-access'));
  if (!document.cookie.split(';').some(item => item.trim() === `${denialCookie}=1`)) throw new LocalStorageError('unavailable');
}
type Access = { format: 1; accountId: string | null; generation: string; scopes: StorageScope[]; clock: number };
type ActiveAccess = Access & { accountId: string };
function validate(value: unknown): Access | null {
  if (value === undefined) return null;
  const record = value as Access;
  if (!record || Object.keys(record).sort().join() !== 'accountId,clock,format,generation,scopes' || record.format !== 1 ||
    (record.accountId !== null && !validUuid(record.accountId)) || !validUuid(record.generation) || !Number.isSafeInteger(record.clock) || record.clock <= 0 || !Array.isArray(record.scopes) ||
    (record.accountId === null && record.scopes.length !== 0) ||
    record.scopes.some(scope => !scope || Object.keys(scope).sort().join() !== 'accountId,organizationId,projectId' || scope.accountId !== record.accountId ||
      !validUuid(scope.organizationId) || !validUuid(scope.projectId)) || new Set(record.scopes.map(scope => `${scope.organizationId}/${scope.projectId}`)).size !== record.scopes.length) throw new LocalStorageError('invalid');
  return record;
}
async function database() {
  const db = await openLocalDatabase('sitegrid-offline-access', 1, (database, _tx, oldVersion) => {
    if (oldVersion !== 0 || database.objectStoreNames.length) throw new LocalStorageError('invalid');
    database.createObjectStore('access');
  });
  if (!plainStore(db, 'access') || db.objectStoreNames.length !== 1) { db.close(); throw new LocalStorageError('invalid'); }
  return db;
}
async function change<T>(work: (current: Access | null, store: IDBObjectStore) => T) {
  const db = await database();
  try { return await localTransaction<T>(db, ['access'], 'readwrite', (tx, result, invalid) => {
    const store = tx.objectStore('access'), request = store.get('current');
    request.onsuccess = () => { try { result(work(validate(request.result), store)); } catch (error) { invalid(storageFailure(error)); } };
  }); } finally { db.close(); }
}
export async function readOfflineAccess(): Promise<ActiveAccess | null> {
  if (offlineAccessDenied()) return null;
  return change((current, store) => {
    if (current) {
      if (Date.now() < current.clock) throw new LocalStorageError('expired');
      current.clock = Date.now(); store.put(current, 'current');
    }
    return current?.accountId ? current as ActiveAccess : null;
  });
}
// Read before requesting /auth/session; a changed generation rejects delayed responses.
export async function offlineAccountGeneration() { return change(current => current?.generation ?? null); }
export async function confirmOfflineAccount(accountId: string | null, expectedGeneration: string | null) {
  if (accountId !== null && !validUuid(accountId)) throw new LocalStorageError('invalid');
  await change((current, store) => {
    if ((current?.generation ?? null) !== expectedGeneration) throw new LocalStorageError('aborted');
    if (accountId === null) store.put(current?.accountId === null ? { ...current, clock: Date.now() } :
      { format: 1, accountId: null, generation: crypto.randomUUID(), scopes: [], clock: Date.now() } satisfies Access, 'current');
    else store.put(current?.accountId === accountId && current.clock <= Date.now() && !offlineAccessDenied() ? { ...current, clock: Date.now() } :
      { format: 1, accountId, generation: crypto.randomUUID(), scopes: [], clock: Date.now() } satisfies Access, 'current');
  });
  document.cookie = `${denialCookie}=; Path=/; SameSite=Strict; Max-Age=0${location.protocol === 'https:' ? '; Secure' : ''}`;
  deniedInMemory = false;
}
export async function invalidateOfflineAccount() {
  denyOfflineAccess();
  // Keep an anonymous generation barrier: delayed pre-logout responses cannot
  // re-establish an old account. A quota failure leaves the denial cookie set.
  const db = await database();
  try { await localTransaction<void>(db, ['access'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('access'); store.delete('current');
    store.put({ format: 1, accountId: null, generation: crypto.randomUUID(), scopes: [], clock: Date.now() } satisfies Access, 'current'); result(undefined);
  }); }
  finally { db.close(); }
}
export async function registerOfflineScope(scope: StorageScope, generation: string) {
  if (offlineAccessDenied()) throw new LocalStorageError('invalid');
  await change((current, store) => {
    if (!current || current.accountId !== scope.accountId || current.generation !== generation || !validUuid(scope.organizationId) || !validUuid(scope.projectId)) throw new LocalStorageError('invalid');
    if (!current.scopes.some(item => item.organizationId === scope.organizationId && item.projectId === scope.projectId)) current.scopes.push(scope);
    store.put(current, 'current');
  });
}
export async function invalidateOfflineProjects(organizationId: string, projectIds?: string[], keep = false) {
  try {
    const removed = await change((current, store) => {
      if (!current) return [];
      const scopes = current.scopes.filter(scope => scope.organizationId === organizationId &&
        (projectIds === undefined || (keep ? !projectIds.includes(scope.projectId) : projectIds.includes(scope.projectId))));
      current.scopes = current.scopes.filter(scope => !scopes.includes(scope)); store.put(current, 'current'); return scopes;
    });
    for (const scope of removed) {
      const handle = await openProjectStorage(scope);
      try { await handle.clear(); } finally { handle.close(); }
    }
    window.dispatchEvent(new Event('sitegrid-offline-access'));
  } catch (error) { denyOfflineAccess(); throw error; }
}
