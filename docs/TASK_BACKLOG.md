# PR21 — backlog, zadania firmy i pulpit pracy

Implementacja kontraktu [Task Management v2](TASK_MANAGEMENT_V2.md), oparta na `main` po PR20 (`1ac7942`). Modularny monolit: `server/task-management/` współdzieli autoryzację istniejących projektów, modułów M08/M10 i nowych ścieżek; React `tasks/` rozdziela listę pracy, szybki formularz i przydział. Bez dodatkowych zależności, podzadań, komentarzy, zdjęć, planów lub kolejki M11.

## Uprawnienia i model

Administrator firmy **bez dodatkowego managera**, kierownik i brygadzista mają zadania wszystkich projektów własnej aktywnej firmy. Zapisy wymagają aktywnego projektu. Administrator platformy nie otrzymuje dostępu przez rolę platformową. Aktywność firmy, konta i członkostwa jest warunkiem każdej operacji.

Pracownik czyta tylko zadania przypisane do swojego aktywnego członkostwa z rolą worker. Ich przypisanie automatycznie zapewnia minimalny kontekst projektu, kontrahenta oraz postęp M08. Samo historyczne członkostwo projektu pracownika nie daje odczytu projektu bez własnego zadania; nie daje cudzych zadań, backlogu, rosteru lub statystyk. Zachowane jawne członkostwa nie są kasowane ani automatycznie tworzone. Członkostwa bez roli roboczej zachowują dotychczasowy odczyt jawnych metadanych bez zadań.

`012_task_backlog.sql` aktualizuje schemat PostgreSQL **11 → 12** bez zmiany rekordów/historycznych migracji. Wykonawca jest nullable, a wykonawca i niezmienny autor mają złożone FK `(organization_id,membership_id)` do członkostwa firmy. FK projektu i receipts pozostają. CHECK wymusza NULL tylko przy `planned`; backlog to **planned + NULL**, bez nowego statusu. Indeks wspiera firmowy zakres pracy. Funkcje działają jako wywołujący i zachowują FORCE RLS; odczyt zadań ma autoryzowany zakres firmy również bez `project_id`, zapis nadal wymaga lokalnego kontekstu projektu. Reguła odczytu zadania nie konsultuje projektów, więc pochodna autoryzacja projektu nie powoduje rekurencji RLS.

Tworzenie wymaga projektu i tytułu; opis jest opcjonalny, brak/pominięcie wykonawcy oznacza NULL. Aktywny wykonawca z kontem może być przypisany bez członkostwa projektu. Przydział/zmiana/cofnięcie są dozwolone przy `planned`. Próba zmiany wykonawcy `in_progress` lub `submitted` zwraca **409 `TASK_ASSIGNMENT_LOCKED`**, także w historycznym endpointcie edycji. Postęp i receipt nigdy nie są resetowane. Taki sam przydział z aktualną wersją jest no-op; stara wersja zawsze daje konflikt. Pracownik nie raportuje postępu za inną osobę, a administrator bez roli wykonawczej nie wykonuje komend.

Mutacje używają dotychczasowej blokady firmy, Origin/CSRF i świeżych kontroli po oczekiwaniu; aktualizacja, wersja i audyt są atomowe. Cofnięcie roli/członkostwa lub blokada konta blokuje nowe zapisy oraz dostęp do receipts. RLS, granica aktora z sesji, izolacja tenantów i nieuprzywilejowany runtime pozostają autorytatywne.

## API

Dotychczasowe ścieżki `/api/organizations/:id/projects/:projectId/tasks` i `/update` pozostają. Projektowe `permissions` uwzględniają nowe role; roster administratora zachowuje historię przydziałów, a kierownik/brygadzista otrzymuje minimalnych aktywnych kandydatów firmy. Pracownik nie ma dostępu do rosteru.

- `GET /api/organizations/:id/tasks` → `{tasks,hasMore,permissions:{manageTasks},membershipId}`. Każdy rekord ma projekt `{projectId,projectName,projectStatus}`, tytuł/opis, wykonawcę/nazwę, status, wersję, czasy i `canProgress`. Brak globalnych liczników.
- Filtry: `view=all|mine|backlog|todo|in_progress|submitted`, `projectId`, `assigneeMembershipId`, `q` (literalne wyszukiwanie tytułu do 200 znaków), `projectStatus=active|archived|all`. Domyślnie aktywne projekty, wszystkie zadania zarządcze / własne pracownika. `todo` to planned z wykonawcą. Pracownik nie filtruje po cudzym wykonawcy ani backlogu (403); pozostałe filtry nadal ogranicza RLS do własnych danych.
- Paginacja: `limit` 1–100, domyślnie 100; `offset` 0–1 000 000. Deterministyczne sortowanie createdAt/id, odczyt LIMIT+1 dla `hasMore`. Offset nie jest spójnym snapshotem podczas równoległych insertów: odśwież listę, aby zobaczyć aktualny zakres; klient eliminuje powtórzone ID. Nie są publikowane liczniki cudzych zadań.
- `GET /api/organizations/:id/task-assignees` → wyłącznie zarządzający: aktywne `{membershipId,displayName}` w tej firmie. Bez profili kadrowych, cudzych firm lub kont platformy.
- `POST /api/organizations/:id/projects/:projectId/tasks/:taskId/assign` → `{assigneeMembershipId:uuid|null,expectedVersion}` i `{task}` po COMMIT. 409 dla starej wersji lub rozpoczętego przydziału; obcy/niedostępny rekord 404, nieaktywny/obcy wykonawca 400.

Wszystkie odpowiedzi API pozostają `no-store`. Archiwum jest czytelne w uprawnionym zakresie, a zapis odrzucany.

## UX i M08/M10

Pulpit od razu pobiera rzeczywiste zadania. Sekcja **Zadania** współdzieli ten sam zamontowany widok, filtry i szkice. Zarządzający ma Wszystkie/Moje/Backlog/Do zrobienia/W trakcie/Do odbioru, projekt, wykonawcę, wyszukiwanie i szybkie tworzenie. Pracownik ma tylko Moje zadania, własne projekty, wyszukiwanie i istniejące akcje postępu. Przydział jest małym formularzem przy zadaniu. Jawne loading/error/empty/confirmed states i responsywne karty działają na desktopie, tablecie i telefonie. Telefon ma zwięzły pasek akcji, poziomo przewijane statusy i zwijane filtry; tytuł pierwszego zadania pozostaje widoczny w początkowym widoku 390 × 844 px.

Zmiana sekcji zachowuje szkice i M08 operationId; zmiana firmy/logout/lokalny odczyt nadal wymagają dotychczasowej ochrony szkiców. Niejednoznaczna komenda blokuje odświeżenie lub destrukcyjną zmianę kontekstu aż do retry tej samej komendy. Potwierdzony brak dostępu usuwa rekord i unieważnia snapshot. Odświeżenie firmowej listy i zmiana przydziału konserwatywnie unieważniają przygotowane snapshoty tej firmy (filtr/paginacja nie są kompletnym snapshotem projektu); ponowne przygotowanie jest jawne. Nie zmieniono schema IDB v2, worker cache, ograniczenia 24 h ani braku remote wipe.

M10 zachowuje format 1/integrity/limity i spójny REPEATABLE READ: zarządzający `taskAccess:project`, przypisany pracownik `own`, historyczne metadata-only członkostwo bez roli `none`. Backlog ma assigneeName NULL. Komendy M08 nadal wymagają własnego wykonawstwa i jawnej roli manager/foreman/worker; nie wymagają członkostwa projektu, lecz pozostałe reguły receipts, idempotencji i stanów pozostają.

## Paczka i weryfikacja

Kontrakt wydania wymaga schematu **12**, upgrade **0–12**. Paczka obejmuje nową migrację, moduły i build PWA. Update robi backup przed migracją. Rollback do kodu PR20/schema 11 jest blokowany przed zatrzymaniem usługi: wymagany kontrolowany restore kopii sprzed migracji, bez SQL downgrade i bez utraty danych przez cichy wybór starszej paczki. Zgodny rollback/schema 12 korzysta z dotychczasowego updatera. Wersja produktu pozostaje 0.1.1 do oddzielnej decyzji o wydaniu; PR21 nie tworzy tagu/release.

Weryfikacja lokalna: Node 24.21.0, PostgreSQL 17.11, oddzielny nieuprzywilejowany runtime z FORCE RLS. `npm run check`: **181/181**, zero pominięć. Nowe testy obejmują pełną migrację populated schema 11 (porównanie wszystkich tabel/checksumów/receipts), 10 zadań/3 projekty, role bez przydziałów, wielofirmowego pracownika, odmowy API i bezpośredniego SQL, wersje/równoległe zapisy, odebrane role/konta, CSRF i rollback audytu. Zachowane testy M07/M08/M09C/M10 mają oczekiwania uprawnień zgodne z PR21, bez pomijania scenariuszy.

Playwright: nowy test zadaniowego pulpitu, tworzenia/przydziału/zmiany/cofnięcia, konfliktu/szkicu, własnego postępu i viewportów 1280/768/390 px; ponadto dotychczasowe siedem zestawów projektów, kontrahentów, brandingu, M08, M10/IndexedDB, PWA/logowania i workspace. Test rzeczywistej paczki i Python: **58/58**, zero pominięć, z update 11 → 12 i blokadą rollbacku do 11. Fizyczne Android/iOS i czysty systemd/Debian pozostają manualnym odbiorem; viewport nie zastępuje urządzenia. Testy rzeczywistej paczki i cyklu update/rollback opisano w [RELEASES](RELEASES.md).
