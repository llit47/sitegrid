# PR13 — komendy postępu zadania (M08)

M08 udostępnia jeden endpoint komend online i polskie akcje „Rozpocznij zadanie” oraz „Zgłoś do odbioru”. Dozwolone przejścia to `planned → in_progress → submitted`. Odbiór, odrzucenie i zwrot do pracy należą do M14. Nie ma PWA, IndexedDB, kolejki offline, wpisów pracy ani załączników.

## Kontrakt v1

`POST /api/organizations/:id/projects/:projectId/tasks/:taskId/commands`

```json
{
  "operationId": "5b51ed70-194f-40bc-b1b7-7755c1fecc9b",
  "schemaVersion": 1,
  "action": "start",
  "expectedVersion": 1
}
```

`action` to `start` lub `submit`. Wszystkie cztery pola są obowiązkowe; nadmiarowe pola, identyfikatory aktora/firmy/projektu w body, nieprawidłowe typy i niecałkowite wersje są odrzucane. `operationId` jest UUID; UUID są normalizowane do małych liter. `expectedVersion` mieści się w 1–2147483646. Wersja schematu komendy jest niezależna od wersji rekordu i schematu PostgreSQL. Nieobsługiwany schemat daje 400 z `UNSUPPORTED_COMMAND_SCHEMA`.

Firma, projekt i zadanie pochodzą z autoryzowanej ścieżki. Aktor pochodzi wyłącznie z sesji; parametr klienta nigdy nie ustala wykonawcy. Każdy zapis wymaga istniejącej ochrony Origin/CSRF. Odpowiedzi API mają `Cache-Control: no-store`.

Sukces 200, wysyłany dopiero po COMMIT:

```json
{
  "operationId": "5b51ed70-194f-40bc-b1b7-7755c1fecc9b",
  "schemaVersion": 1,
  "task": {
    "id": "72bd6b88-6e36-4ce8-9130-0b9e6c55bb9a",
    "status": "in_progress",
    "version": 2,
    "updatedAt": "2026-10-10T06:00:00.000Z"
  }
}
```

To utrwalony wynik konkretnej operacji. Retry zwraca ten sam snapshot, również gdy późniejsza komenda lub edycja zwiększyła wersję zadania. Do pobrania bieżącego stanu służy istniejący GET zadania. Zmiana statusu zwiększa wersję dokładnie raz; znaczniki czasu tworzy PostgreSQL (`clock_timestamp()`), a nie urządzenie.

| Wynik | Znaczenie |
|---|---|
| 400 | Nieprawidłowy kontrakt lub nieobsługiwany schemat |
| 401 | Brak/wygaśnięcie/unieważnienie sesji albo zablokowane konto |
| 403 | Niedostępna firma/członkostwo albo niepoprawny Origin/CSRF |
| 404 | Niedostępny projekt/zadanie, brak roli roboczej, przydziału lub własności zadania; bez ujawnienia rekordu |
| 409 `OPERATION_ID_REUSED` | Ten sam identyfikator operacji z inną treścią lub ścieżką |
| 409 `STALE_TASK_VERSION` | Uprawniony wykonawca podał starą wersję; odpowiedź zawiera jego bieżący snapshot zadania |
| 409 `INVALID_TASK_TRANSITION` | Akcja niedozwolona dla bieżącego statusu; bez zmiany danych |
| 409 `PROJECT_ARCHIVED` | Nowa komenda w projekcie archiwalnym |
| 503 | Błąd usługi/bazy/audytu; bez częściowego zapisu |

## Bieżące uprawnienia i idempotencja

Wymagane jest przecięcie aktywnego konta, firmy, członkostwa firmy, jawnej roli `worker`, `foreman` lub `manager`, aktywnego przydziału do projektu oraz **własnego wykonawstwa zadania**. Kierownik i brygadzista nie zgłaszają postępu za inną osobę. Administrator firmy potrzebuje osobnej roli roboczej, przydziału i własnego zadania; administrator platformy nie ma wyjątku.

Transakcja używa istniejącego `withAuthorizedOrganization` i wspólnej blokady firmy. Funkcja blokady znajduje się w `common/organization-lock.ts`, zachowując historyczny klucz SQL używany także przez triggery i istniejące mutacje. Po uzyskaniu blokady API ponownie sprawdza sesję z aktualnym czasem bazy, konto, aktywność firmy/członkostwa, role, przydział i wykonawcę. Dopiero potem odczytuje receipt. Odwołanie dostępu blokuje zarówno nową komendę, jak i replay starego wyniku. Archiwizacja zachowuje uprawniony odczyt historii i receipts, lecz blokuje nowe zmiany.

`task_progress_receipts` ma unikalny klucz `(organization_id, actor_id, operation_id)`, złożony FK do zadania oraz FK do zdarzenia audytu tej samej firmy. Przechowuje wersję kontraktu, kanoniczny SHA-256 i utrwalony JSON odpowiedzi. Hash obejmuje autoryzowaną firmę/projekt/zadanie/aktora, wersję schematu, akcję i oczekiwaną wersję w stałej kolejności; kolejność pól JSON i białe znaki transportu nie wpływają na hash.

Identyczne równoległe żądania wykonują jeden zapis, a kolejne zwracają utrwalony wynik. Zmieniona treść jest konfliktem. Gdy receipt z innego projektu jest niewidoczny przez RLS, unikalny klucz nadal blokuje ponowne użycie ID; cała próba zapisu zostaje wycofana, a API zwraca bezpieczny konflikt bez danych starego zadania. Odrzucone komendy nie tworzą receipts. W MVP nie ma automatycznego usuwania potwierdzonych receipts.

Status, wersja, audit i receipt zapisują się na tym samym połączeniu i w tej samej transakcji. Audyt `task_started`/`task_submitted` zawiera firmę, aktora, zadanie, projekt, `operationId`, wersję kontraktu oraz wersje/statusy przed i po. Błąd audytu, zapisu receipt lub COMMIT nie daje częściowego sukcesu. Utrata odpowiedzi po COMMIT wymaga ponowienia z **tym samym ID i treścią**. Retry po restarcie procesu korzysta wyłącznie z PostgreSQL.

Tabela receipts ma ENABLE/FORCE RLS i granty runtime tylko SELECT/INSERT, bez UPDATE/DELETE/TRUNCATE. Odczyt wymaga tego samego aktora i aktualnego dostępu do własnego zadania; obcy tenant i kontekst projektu są odcięte. Polityki zadań dopuszczają zapis postępu własnego wykonawcy. Trigger nadal chroni tożsamość, autora, przydział, wersję i czas: zwykłe API edycji nie przyjmuje statusu, a SQL edycji nie może go zmienić. Kontekst komendy zezwala wyłącznie na dwa przejścia i nie może zmieniać opisu, tytułu ani wykonawcy. GUC są zaufaną granicą serwera, nigdy payloadem klienta; nie zastępują autoryzacji sesji. Kontekst znika po COMMIT/ROLLBACK.

## Moduły i interfejs

`apps/server/src/task-progress/` rozdziela route (`routes.ts`), kontrakt/przejścia/hash (`domain.ts`), przebieg transakcyjnej komendy (`service.ts`) i SQL (`persistence.ts`). Wspólny audyt znajduje się w `common/audit.ts`. Rejestracja to jeden import i wywołanie w istniejącym komponowaniu routes; moduł nie zależy od zaproszeń ani innych feature modules.

`apps/web/src/task-progress.tsx` odpowiada za akcje i feedback; `projects.tsx` tylko komponuje komponent i przyjmuje potwierdzony snapshot. API odczytu zadania dodaje `canProgress`, wyliczone z bieżących uprawnień. Interfejs pokazuje stan i wersję, blokuje dwuklik synchronicznym guardem i przyciskiem disabled, nie zmienia stanu przed potwierdzeniem. Konflikt wymaga jawnego „Wczytaj aktualne dane”. Po błędzie sieci/5xx przycisk „Ponów operację” zachowuje ten sam request w pamięci zamontowanego komponentu. Nie ma trwałej kolejki ani automatycznego replay. Zmiana firmy/projektu odmontowuje komponent, anuluje request i ignoruje spóźnioną odpowiedź. Odmowa dostępu usuwa widok zadania. Starszy receipt nie obniża wersji już znanej w UI.

## Migracja i wydanie

`010_task_progress.sql` podnosi schemat 9 → 10, zachowując wszystkie dane PR12 i wcześniejsze: konta, hasła, sesje, firmy, członkostwa, role, profile, zaproszenia, logo, projekty, przydziały, zadania, wersje, timestamps i audyt. Zmienia ograniczenie statusu i task trigger, dodaje politykę postępu i receipts. Nie nadaje automatycznych ról/przydziałów. Istniejące migracje i ich checksums pozostają bez zmian.

`release.json` wymaga schematu 10 i dopuszcza upgrade 0–10. Installer/update używają istniejącej paczki i migratora, wykonując backup przed migracją. Kod PR12 deklarujący wyłącznie schemat 9 jest niezgodny z DB 10; rollback wymaga kontrolowanego restore kopii sprzed migracji. Backup obejmuje także receipts i audyt. Restore może utracić wcześniej potwierdzone operacje; nie stanowi gwarancji dokładnie jednego efektu wobec utraconej historii. Epoka synchronizacji i uzgodnienie po restore pozostają M12/M15.

## Weryfikacja

`tests/task-progress.test.ts` używa prawdziwego PostgreSQL 17 i osobnego nieuprzywilejowanego runtime: przejścia, role, wiele firm/wspólne konto, obce ID, kanoniczne retry, zmieniony payload/ścieżka, równoległe duplikaty, konflikt urządzeń, fizyczne zerwanie socketu HTTP po COMMIT, replay w nowym procesie Node, odwołanie roli/przydziału/członkostwa/firmy/wykonawcy, blokada konta, usunięta/wygasła sesja również podczas oczekiwania na lock, błędy audytu/receipt i rollback, FORCE RLS, granty oraz migracja wypełnionej bazy 9 → 10. Cały zestaw jest częścią `npm run check`; przy ustawionym owner URL brak runtime URL jest błędem.

`tests/task-progress-browser.mjs` sprawdza desktop 1280 px i mobilny viewport 390 px: widoczność ról, start/submit, dwuklik, opóźnione potwierdzenie, konflikt/refresh, utratę odpowiedzi, 503 i retry tego samego ID, zmianę firmy podczas requestu, przyciski dotykowe i utratę przydziału. Uruchomienie po buildzie z dwoma URL PostgreSQL oraz Playwright/Chromium przez `SITEGRID_PLAYWRIGHT_MODULE`/`SITEGRID_CHROMIUM_PATH`, jak dla PR12. Emulacja viewportu nie zastępuje fizycznego Androida/iPhone'a w przyszłej bramce MVP.

Wyniki lokalne 2026-10-10: Node 24.21.0, PostgreSQL 17.11, runtime `sitegrid` bez superuser/BYPASSRLS/CREATEROLE. `npm run check`: 132/132, zero skips. Zestaw Python z faktycznie zbudowaną paczką: 54/54 (installer, podpisany kanał, update, rollback, konkretne kontrakty 9 → 10 i blokada powrotu do 9). Wszystkie trzy zestawy browser (`task-progress`, `projects`, `organization-branding`) przeszły desktop/mobile; brak błędów runtime. Walidacje shell/Python/JS i `git diff --check` przeszły. Nie wykonywano świeżej instalacji na Debianie 13/systemd ani testów na fizycznym Androidzie/iPhonie w tym przyroście. Wspólna blokada serializuje zapisy firmy — akceptowany kompromis małego MVP; restore sprzed potwierdzonej komendy nadal wymaga uzgodnienia utraconej historii, a UI nie utrwala przerwanego requestu po zamknięciu strony.

## M10 / PR17 — odczyt offline

[Przygotowany snapshot](PROJECT_SNAPSHOTS.md) pokazuje autoryzowane statusy/wersje wyłącznie do odczytu. Nie udostępnia komend offline, nie utrwala przerwanego M08 requestu i nie odtwarza go po reconnect. Przejścia, receipt, idempotencja, retry w pamięci i dotychczasowe uprawnienia pozostają bez zmian. Trwałość komend będzie osobnym M11.
