import { LocalStorageError } from '../storage/indexed-db.js';
export function offlineFailureMessage(error: unknown): string {
  if (error instanceof LocalStorageError) return {
    unavailable: 'Pamięć lokalna niedostępna. Korzystaj z aplikacji online.',
    blocked: 'Pamięć lokalna zablokowana. Zamknij inne okna SiteGrid i ponów przygotowanie.',
    quota: 'Brak miejsca w pamięci lokalnej. Nowy snapshot nie został zapisany.',
    aborted: 'Zapis został przerwany. Nowy snapshot nie został potwierdzony.',
    invalid: 'Uszkodzony lub nieobsługiwany format danych lokalnych. Dane nie zostały usunięte; sprawdź wersję aplikacji.',
    failed: 'Nie udało się odczytać lub zapisać pamięci lokalnej. Ponów przygotowanie online.',
    expired: 'Dostęp offline wygasł lub zegar urządzenia zmienił się. Potwierdź konto i przygotuj projekt online.',
    stale: 'Pobrany snapshot nie jest nowszy od zapisanego. Poprzednie dane zachowano; ponów odświeżenie.',
  }[error.code];
  if (error instanceof TypeError || error instanceof SyntaxError) return 'Nie udało się pobrać kompletnego projektu. Sprawdź połączenie i ponów przygotowanie.';
  return error instanceof Error ? error.message : 'Przygotowanie offline nie powiodło się.';
}
