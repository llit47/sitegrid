# PR10 — administrator firmy, członkowie i pracownicy (M05)

Po wybraniu firmy w istniejącym przełączniku aktywny `organization_admin` widzi członkostwa, ich statusy, wszystkie przypisane role i lokalne profile pracowników. Filtr obejmuje aktywnych, nieaktywnych i oczekujących. Profile bez konta są wyświetlane osobno. Kierownik, brygadzista, pracownik oraz administrator platformy bez jawnej roli w tej firmie nie mają dostępu do panelu ani API.

## Model i działania

`users` pozostaje globalną tożsamością. `employee_profiles` przechowuje tylko nazwę pracownika (`displayName`, 1–120 znaków), stanowisko (`position`, opcjonalne, do 120 znaków) i telefon (`phone`, opcjonalny, do 40 znaków). Pola są tekstowe, przycinane i nie mogą zawierać znaków sterujących. Profil należy do jednej firmy. Opcjonalne `membershipId` wskazuje istniejące członkostwo tej samej firmy przez złożony FK; jedno członkostwo może mieć jeden profil. Powiązanie ustala się przy tworzeniu i zachowuje na stałe. Profil bez powiązania nie tworzy konta, hasła ani dostępu do aplikacji. Konta zaprasza się mechanizmem [PR9](INVITATIONS.md).

Role nadaje się i usuwa pojedynczo: `organization_admin`, `manager`, `foreman`, `worker`. Dodatkowa rola nie zastępuje dotychczasowych; żadna nie nadaje roli platformowej. Powtórzenie nadania istniejącej roli lub usunięcia nieprzypisanej roli jest bez skutku. Dezaktywacja zachowuje członkostwo, role, profil i audyt. Reaktywacja jest oddzielną, autoryzowaną akcją. Oczekującego członkostwa nie można aktywować tym API: wymaga akceptacji zaproszenia.

Profil i powiązane członkostwo mają jeden status. Triggery synchronizują zmianę w obie strony w tej samej transakcji. Dezaktywacja profilu powiązanego z kontem odbiera dostęp tylko w tej firmie. Profil bez konta ma własny status. API nie kasuje członkostw ani profili. Nie zmienia globalnego emaila, hasła, blokady konta ani członkostw w innych firmach. Autoryzacja sprawdza bieżącą sesję, konto, firmę, członkostwo i rolę przy każdym żądaniu; odwołany dostęp obowiązuje od następnego żądania, bez logoutu.

## API

Wszystkie ścieżki zaczynają się od `/api/organizations/:id` i wymagają aktywnego administratora wybranej firmy.

| Metoda i ścieżka | Dane / wynik |
|---|---|
| GET `/members` | `{ members }`: lokalne ID członkostwa, email konta, status, tablica ról i opcjonalny profil |
| GET `/employees` | `{ employees }`: profile wyłącznie tej firmy |
| POST `/members/:membershipId/roles/assign` lub `/roles/remove` | `{ role }`, jedna rola z katalogu |
| POST `/members/:membershipId/deactivate` lub `/reactivate` | `{}` |
| POST `/employees` | `{ displayName, position?, phone?, membershipId? }`; 201 z `{ employee }` |
| POST `/employees/:employeeId/update` | `{ displayName, position?, phone? }` |
| POST `/employees/:employeeId/deactivate` lub `/reactivate` | `{}`; dla powiązanego profilu zmienia także członkostwo |

Każdy POST wymaga CSRF i zgodnego Origin. Serwer odrzuca dodatkowe pola i niepoprawne typy. Brak własnego dostępu daje 401/403; obcy identyfikator rekordu w autoryzowanej firmie daje 404. Powtórny profil, zmiana statusu oczekującego członkostwa lub próba odebrania administracji ostatniemu administratorowi daje 409. Listy nie stanowią globalnego katalogu użytkowników. Odpowiedzi API mają `Cache-Control: no-store`.

## Izolacja, ostatni administrator i audyt

Migracja `007_company_members.sql` dodaje `employee_profiles` i `organization_audit_events` z ENABLE/FORCE RLS. Polityki wymagają lokalnego, transakcyjnego kontekstu firmy. Runtime otrzymuje SELECT/INSERT/UPDATE do profili i SELECT/INSERT do audytu; nie otrzymuje DELETE profili, UPDATE/DELETE audytu, TRUNCATE, własności ani nowych uprawnień do globalnej tożsamości. Funkcje triggerów działają jako wywołujący z RLS; brak `SECURITY DEFINER`.

Zmiany członkostw, ról, profili i zaproszeń używają tej samej blokady `pg_advisory_xact_lock` dla firmy co PR9. Po oczekiwaniu API ponownie sprawdza sesję i aktualną administrację. Zaproszenia również ponownie sprawdzają wystawcę po oczekiwaniu na tę blokadę. Przyjęcie zaproszenia nadal zachowuje role i status istniejącego aktywnego członkostwa; oczekującego lub nieaktywnego nie nadpisuje.

Triggery bazy blokują usunięcie roli, zmianę aktywnego członkostwa i usunięcie ostatniego aktywnego administratora, również przy równoległym SQL. Przekazanie administracji wymaga innego aktywnego członkostwa z jawną rolą administratora i nieblokowanym kontem. Kontrola po blokadzie wymaga świeżego snapshotu `READ COMMITTED`, używanego przez aplikację. Próba odbierania administracji przy `REPEATABLE READ`/`SERIALIZABLE` kończy się błędem 40001, aby starszy snapshot nie osłabił ochrony. Nie dodaje się platformowej ścieżki odzyskania administracji. Istniejące firmy bez administratorów nie są automatycznie naprawiane migracją.

Każda rzeczywista zmiana ma zdarzenie w `organization_audit_events` z aktorem, firmą, lokalnym ID przedmiotu i rodzajem działania. Zmiany ról zapisują rolę, zmiany statusu stan przed/po, a działanie na powiązanym profilu także ID członkostwa. Jeden zapis obejmuje atomową zmianę statusu profilu i członkostwa. Audyt jest częścią tej samej transakcji: jego błąd wycofuje całą operację. Dane logowania i tokeny nie trafiają do tego audytu. Dotychczasowy audyt zaproszeń pozostaje zachowany.

## Migracja i weryfikacja

Schemat 6 → 7 zachowuje istniejące konta, hasła, sesje, firmy, członkostwa, role i zaproszenia. Nie tworzy automatycznych profili. `release.json` wymaga schematu 7 i dopuszcza aktualizację ze schematów 0–7. Powrót do wydania deklarującego wyłącznie schemat 6 wymaga kontrolowanego odtworzenia bazy; zwykły rollback jest blokowany przez dotychczasowy kontrakt.

`tests/company-members.test.ts` sprawdza migrację z danymi PR9, A/B i wspólne konto, role wielokrotne, lokalne profile, cofnięcie dostępu, walidację, CSRF/Origin, FORCE RLS, FK, uprawnienia runtime, audyt i rollback. Wyścigi obejmują dwa usunięcia roli, dwie dezaktywacje, ich kombinację, profile administratorów i bezpośredni SQL; żądanie czekające na blokadę nie działa po odwołaniu roli aktora. Poprzednie testy członkostw i zaproszeń przekazują administrację przed odebraniem roli wystawcy, zachowując swoje scenariusze.

Uruchom `npm run check` lub `node --import tsx --test tests/company-members.test.ts tests/invitations.test.ts` z rzeczywistymi `TEST_DATABASE_URL` i `TEST_RUNTIME_DATABASE_URL` według [DEVELOPMENT.md](DEVELOPMENT.md).
