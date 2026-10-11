import { useCallback, useEffect, useRef } from 'react';
import { hasPendingOperations } from '../workspace/navigation-safety.js';

// One reader per resource. New queries and mutations fence off obsolete responses.
export function useLiveResource<T>(key: string, read: (signal: AbortSignal) => Promise<T>, {
  active = true, paused = false, receive, failed,
}: { active?: boolean; paused?: boolean; receive: (data: T) => void; failed: (error: { message: string; status?: number }) => void }) {
  const latest = useRef({ key, read, receive, failed, paused });
  latest.current = { key, read, receive, failed, paused };
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let controller: AbortController | null = null, disposed = false;
    const eligible = () => active && navigator.onLine && document.visibilityState === 'visible';
    const run = async (background = false) => {
      if (!eligible() || controller || (!background && (latest.current.paused || hasPendingOperations()))) return;
      const current = new AbortController(); controller = current;
      try {
        const data = await latest.current.read(current.signal);
        if (!disposed && latest.current.key === key && !current.signal.aborted && !latest.current.paused && !hasPendingOperations()) latest.current.receive(data);
      } catch (error) {
        if (!disposed && latest.current.key === key && !current.signal.aborted) latest.current.failed(error as Error);
      } finally { if (controller === current) controller = null; }
    };
    const resume = () => {
      if (!eligible()) { controller?.abort(); controller = null; }
      else void run(true);
    };
    const settled = () => { void run(); };
    refreshRef.current = () => { void run(); };
    void run();
    const timer = window.setInterval(() => void run(true), 15_000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('sitegrid-operations-settled', settled);
    window.addEventListener('online', resume); window.addEventListener('offline', resume);
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('sitegrid-operations-settled', settled);
      window.removeEventListener('online', resume); window.removeEventListener('offline', resume);
      refreshRef.current = () => {};
    };
  }, [key, active]);
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current && !paused) refresh();
    wasPaused.current = paused;
  }, [paused, refresh]);
  return refresh;
}
