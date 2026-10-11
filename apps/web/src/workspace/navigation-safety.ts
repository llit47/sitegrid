import { useEffect } from 'react';

// Kept in memory only. Section navigation preserves components; destructive navigation
// must wait for confirmation, including M08 commands with an ambiguous response.
const pending = new Set<symbol>();
const draftGuards = new Set<() => boolean>();
export function useDraftGuard(hasDraft: () => boolean) {
  useEffect(() => { draftGuards.add(hasDraft); return () => { draftGuards.delete(hasDraft); }; }, [hasDraft]);
}
export function usePendingOperation(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const token = Symbol(); pending.add(token);
    return () => { pending.delete(token); };
  }, [active]);
}
export function hasDirtyForms(root: ParentNode = document): boolean {
  if ((root === document && [...draftGuards].some(check => check())) || root.querySelector('form[data-unsaved-draft="true"]')) return true;
  return [...root.querySelectorAll('form input, form select, form textarea')].some(element => {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'file') return !!element.files?.length;
      if (['checkbox', 'radio'].includes(element.type)) return element.checked !== element.defaultChecked;
      if (element.readOnly || ['submit', 'button', 'hidden'].includes(element.type)) return false;
      return element.value !== element.defaultValue;
    }
    if (element instanceof HTMLTextAreaElement) return element.value !== element.defaultValue;
    if (element instanceof HTMLSelectElement) {
      const initial = element.dataset.initialValue ?? ([...element.options].find(option => option.defaultSelected) ?? element.options[0])?.value ?? '';
      return element.value !== initial;
    }
    return false;
  });
}
export function guardPendingOperations(): boolean {
  if (pending.size) {
    window.alert('Operacja czeka na potwierdzenie serwera. Poczekaj lub ponów tę samą operację przed opuszczeniem tego widoku.');
    return false;
  }
  return true;
}
export function guardWorkspaceChange(root: ParentNode = document): boolean {
  if (!guardPendingOperations()) return false;
  return !hasDirtyForms(root) || window.confirm('Masz niezapisane zmiany. Opuścić widok i odrzucić formularz?');
}
export function useUnloadGuard() {
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (pending.size || hasDirtyForms()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, []);
}
