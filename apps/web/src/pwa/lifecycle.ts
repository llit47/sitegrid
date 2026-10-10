export type ShellState = 'preparing' | 'ready' | 'unavailable' | 'update' | 'activating';
export async function shellIsAvailable(): Promise<boolean> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return false;
  const worker = navigator.serviceWorker.controller ?? (await navigator.serviceWorker.getRegistration('/'))?.active;
  if (!worker) return false;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (ready: boolean) => { clearTimeout(timeout); channel.port1.close(); resolve(ready); };
    const timeout = setTimeout(() => finish(false), 5000);
    channel.port1.onmessage = event => finish(event.data?.ready === true);
    try { worker.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]); } catch { finish(false); }
  });
}
export function registerShell(onState: (state: ShellState) => void): () => void {
  let disposed = false;
  let updateAvailable = false;
  const cleanups: Array<() => void> = [];
  const publish = (state: ShellState) => {
    if (state === 'update') updateAvailable = true;
    if (state === 'activating') updateAvailable = false;
    if (!disposed) onState(updateAvailable && state === 'ready' ? 'update' : state);
  };
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) {
    publish('unavailable'); return () => { disposed = true; };
  }
  const status = (worker: ServiceWorker) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); publish('unavailable'); }, 5000);
    channel.port1.onmessage = event => {
      clearTimeout(timeout); channel.port1.close(); publish(event.data?.ready === true ? 'ready' : 'unavailable');
    };
    cleanups.push(() => { clearTimeout(timeout); channel.port1.close(); });
    worker.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]);
  };
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(registration => {
    if (disposed) return;
    if (registration.waiting) publish('update');
    else if (registration.active) status(registration.active);
    const watch = () => {
      const worker = registration.installing;
      if (!worker) return;
      const change = () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) publish('update');
        if (worker.state === 'activating') publish('activating');
        if (worker.state === 'activated') status(worker);
        if (worker.state === 'redundant') {
          if (registration.active) status(registration.active); else publish('unavailable');
        }
      };
      worker.addEventListener('statechange', change); cleanups.push(() => worker.removeEventListener('statechange', change)); change();
    };
    registration.addEventListener('updatefound', watch); cleanups.push(() => registration.removeEventListener('updatefound', watch)); watch();
    const update = () => { if (navigator.onLine) void registration.update().catch(() => { /* Keep the working shell. */ }); };
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    window.addEventListener('online', update); document.addEventListener('visibilitychange', visible);
    cleanups.push(() => { window.removeEventListener('online', update); document.removeEventListener('visibilitychange', visible); });
  }).catch(() => publish('unavailable'));
  return () => { disposed = true; cleanups.forEach(cleanup => cleanup()); };
}
// One channel per mounted shell: BroadcastChannel excludes the sending object,
// so notifications invalidate other tabs without remounting the initiating tab.
let accountChannel: BroadcastChannel | null = null;
export function announceAccountChange(): void {
  try {
    // Ordered prefix says M10 already established its durable local fence.
    // Keep the original signal for still-open M09 clients during an update.
    accountChannel?.postMessage({ type: 'local-fence', format: 2 });
    accountChannel?.postMessage('changed');
  }
  catch { /* Optional browser storage must never block login/logout. */ }
}
export function subscribeAccountChanges(invalidate: (legacy: boolean) => void): () => void {
  try {
    if (!('BroadcastChannel' in window)) return () => {};
    const channel = new BroadcastChannel('sitegrid-account-change');
    accountChannel = channel;
    let fenced = false;
    channel.onmessage = event => {
      if (event.data?.type === 'local-fence' && event.data.format === 2) { fenced = true; return; }
      if (event.data === 'changed') { const legacy = !fenced; fenced = false; invalidate(legacy); }
    };
    return () => { if (accountChannel === channel) accountChannel = null; channel.close(); };
  } catch { return () => {}; }
}
