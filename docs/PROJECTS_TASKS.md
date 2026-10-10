# PR12 — projekty, przydziały i zadania online (M07)

Po wybraniu firmy użytkownik widzi dostępne projekty. Administrator firmy tworzy projekt, edytuje nazwę/opis, archiwizuje go i jawnie przypisuje aktywne członkostwa firmy. Utworzenie projektu nie przypisuje automatycznie autora. Role nadal pochodzą z `membership_roles`; nie ma nowych ról globalnych ani osobnego katalogu ról projektowych.

## Uprawnienia

| Użytkownik | Metadane i członkostwa | Zadania |
|---|---|---|
| Administrator firmy | Wszystkie projekty własnej firmy w celu administracji; przydziały tylko aktywnych członków tej firmy | Sama administracja i nawet przydział do projektu nie dają odczytu lub zapisu zadań |
| Kierownik | Jawnie przypisane projekty; minimalna lista uprawnionych wykonawców | Odczyt, tworzenie, edycja i zmiana wykonawcy tylko w przypisanym projekcie |
| Brygadzista | Jawnie przypisane projekty; bez panelu kadrowego i zarządzania przydziałami | Odczyt zadań tych projektów |
| Pracownik | Jawnie przypisane projekty; bez listy członków | Wyłącznie własne zadania |
| Członek bez roli roboczej | Metadane jawnie przypisanego projektu | Brak dostępu do zadań |
| Administrator platformy | Brak domyślnego dostępu | Brak domyślnego dostępu |

Administrator z dodatkową jawną rolą `manager`, `foreman` lub `worker` podlega tym samym regułom i musi mieć aktywny przydział projektowy. Administracyjny odczyt metadanych służy zarządzaniu projektami i nie nadaje dostępu do pracy projektu. Przecięcie aktywnego konta, firmy, członkostwa, roli, przydziału i relacji do zadania odpowiada [PERMISSIONS.md](audit/PERMISSIONS.md).

## Model i historia

Migracja `009_projects_tasks.sql` dodaje trzy tabele:

- `projects`: klucz `(organization_id, id)`, nazwa 1–200 znaków Unicode, opcjonalny opis do 4000 znaków, status `active`/`archived`, wersja i czasy UTC z bazy.
- `project_memberships`: klucz `(organization_id, project_id, membership_id)`, FK do projektu i członkostwa **tej samej firmy**, status `active`/`inactive`, wersja i czasy. Odebranie przydziału aktualizuje rekord zamiast go usuwać. Reaktywacja nie resetuje wersji.
- `tasks`: klucz `(organization_id, project_id, id)`, tytuł 1–200 znaków, opcjonalny opis do 4000 znaków, wykonawca, niezmienny autor jako lokalne ID członkostwa, status początkowy `planned`, wersja i czasy. Złożone FK wykonawcy i autora wskazują członkostwa tego samego projektu i firmy.

Tekst jest przycinany i nie może zawierać znaków sterujących; pominięty opis zapisuje się jako pusty tekst. `null`, nieprawidłowe typy i nadmiarowe pola są odrzucane. Wykonawca przy tworzeniu i każdej edycji musi mieć aktywne, nieblokowane konto, aktywne członkostwo firmy i projektu. Odebranie dostępu zachowuje stare zadania i autora; kierownik może wskazać innego uprawnionego wykonawcę. Reaktywacja członkostwa firmy przywraca zachowany aktywny przydział projektu; aby odebrać go trwale, administrator jawnie odwołuje także przydział.

Archiwizacja zachowuje członkostwa, zadania i audyt. Projekt archiwalny pozostaje w uprawnionym odczycie, lecz metadane, członkostwa i zadania są tylko do odczytu. Nie ma usuwania ani destrukcyjnych FK `ON DELETE CASCADE`, odarchiwizowania, postępu, komend zmiany statusu, wpisów pracy, załączników, PWA lub synchronizacji offline. Przejścia statusu i idempotentne komendy należą do M08.

## API

Każda ścieżka ma jawny kontekst `/api/organizations/:id/projects`. Aktor pochodzi z sesji. Payload nie może podawać aktora, firmy, projektu, autora ani statusu zadania.

| Metoda i dalsza ścieżka | Wynik / payload |
|---|---|
| GET `/` | `{ projects }`; administrator: metadane firmy, inni: własne aktywne przydziały |
| POST `/` | `{ name, description? }`; 201 z `{ project }` |
| GET `/:projectId` | `{ project, permissions: { administer, readTasks, manageTasks } }` |
| POST `/:projectId/update` | `{ name, description?, expectedVersion }` |
| POST `/:projectId/archive` | `{ expectedVersion }` |
| GET `/:projectId/members` | `{ members }`; administrator: kandydaci i zachowane przydziały, przypisany kierownik: uprawnieni wykonawcy; tylko ID członkostwa, nazwa, statusy i wersja |
| POST `/:projectId/members/:membershipId` | `{ status: 'active' \| 'inactive', expectedVersion }`; pierwsze nadanie ma wersję oczekiwaną 0, istniejący przydział swoją aktualną wersję |
| GET `/:projectId/tasks` | `{ tasks }`, zakres według roli i wykonawcy; nazwa wykonawcy bez danych kadrowych |
| GET `/:projectId/tasks/:taskId` | `{ task }`, taki sam zakres jak lista |
| POST `/:projectId/tasks` | `{ title, description?, assigneeMembershipId }`; 201 z `{ task }` |
| POST `/:projectId/tasks/:taskId/update` | `{ title, description?, assigneeMembershipId, expectedVersion }` |

UUID, rodzaje pól, długości, wersje i uprawnienie wykonawcy są walidowane w API i chronione więzami bazy. `expectedVersion` jest liczbą całkowitą, poniżej 2147483647. Wersja zmienia się o 1. Ponowne nadanie już aktywnego przydziału z jego aktualną wersją nie tworzy zdarzenia ani nowej wersji.

Brak sesji lub blokada konta daje 401; niedostępna firma, rola administracyjna lub CSRF/Origin — 403; niedostępny/obcy projekt lub zadanie — 404; nieuprawniony wykonawca lub błędny payload — 400; konflikt wersji i próba zmiany archiwum — 409. Obcy rekord nie ujawnia aktualnej wersji. Konflikt dla uprawnionej osoby zwraca aktualny `project`, `task` lub `membership`. Wszystkie API mają `Cache-Control: no-store`.

## Transakcje i RLS

API używa istniejącego `withAuthorizedOrganization` i rzeczywistego nieuprzywilejowanego runtime. Mutacje wymagają dokładnego `Origin` i poprawnego CSRF. Każdy zapis współdzieli transakcyjną blokadę firmy z członkostwami, zaproszeniami i brandingiem. Po oczekiwaniu sprawdza ponownie sesję, aktywne konto, firmę, członkostwo, role i przydział. Termin sesji porównuje z `clock_timestamp()`, aby długie oczekiwanie nie zachowało wygasłego dostępu. Dopiero potem waliduje wykonawcę, wersję, zapis i audyt na tym samym połączeniu. To celowe serializowanie zapisów małego MVP w firmie.

Wszystkie trzy tabele mają `ENABLE/FORCE ROW LEVEL SECURITY`. Runtime otrzymuje wyłącznie SELECT/INSERT/UPDATE; bez DELETE, TRUNCATE, własności lub obejścia RLS. Funkcje działają jako wywołujący, bez `SECURITY DEFINER`. Odczyt projektów wymaga własnego aktywnego przydziału lub jawnej administracji metadanymi; zapis wymaga administratora firmy. Polityki zadań dodatkowo sprawdzają aktywny przydział, bieżącą rolę i własność zadania pracownika.

`sitegrid.project_id` jest lokalne dla transakcji i ustawiane przez API dopiero po autoryzacji projektu. Zadania bez tego kontekstu lub w innym projekcie są niewidoczne. Polityki członkostw dopuszczają własne przydziały do discovery, administrację oraz minimalny roster kierownika w autoryzowanym kontekście projektu. Sam kontekst rosteru nie daje dostępu do projektu lub zadań. Podobnie jak w M03, GUC i rola SQL są zaufaną granicą serwera; nie są wartościami przyjmowanymi od klienta. Nie wolno używać samego `set_config` jako autoryzacji. COMMIT/ROLLBACK usuwa kontekst firmy, aktora i projektu, także na tym samym połączeniu puli.

Triggery chronią tożsamości rekordów, autora i początkowy status, zwiększenie wersji, czas bazy, aktywność projektu i wykonawcy. Audyt `project_created`, `project_updated`, `project_archived`, `project_member_assigned`, `project_member_revoked`, `task_created`, `task_updated` zapisuje firmę, aktora, przedmiot, wersję przed/po oraz kontekst projektu i zmianę wykonawcy lub przydziału. Błąd audytu wycofuje cały zapis. Audyt administracyjny nie jest udostępniany kierownikom przez API projektów.

## UI, migracja i weryfikacja

Polski interfejs obsługuje listę i szczegóły projektów, członków, zadania, formularze i wybór wykonawcy. Przy zmianie firmy/projektu poprzedni widok jest odmontowywany, odczyty i zapisy anulowane, a spóźnione wyniki ignorowane. Odmowa dostępu usuwa poprzednie dane. Błąd odczytu nie pozostawia poprzedniej listy. Formularz po 409 zachowuje propozycję; „Wczytaj aktualne dane” jawnie zastępuje niezapisane formularze aktualnym stanem. Dostępne są stany ładowania, braku danych, błędu i ponowienia. Przyciski i listy działają na wąskim ekranie.

Schemat 8 → 9 zachowuje dane PR11: konta, hasła, sesje, firmy, członkostwa, role, pracowników, zaproszenia, ustawienia, bajty logo i audyt. Nie tworzy projektów, przydziałów ani ról automatycznie. Kontrakt wydania wymaga schematu 9 i dopuszcza upgrade 0–9. Wydanie PR11 deklarujące schemat 8 nie jest zgodne z bazą 9; powrót wymaga kontrolowanego restore backupu. Instalator/updater i podpisy pozostają zgodne z istniejącym procesem.

`tests/projects-tasks.test.ts` obejmuje dwie firmy, wiele projektów i wspólne konto, role i przydziały, CRUD bez usuwania, odczyty pracownika/kierownika/brygadzisty, obce ID i wykonawców, odebrany dostęp, CSRF, wersje i wyścigi, audyt i rollback, FORCE RLS, złożone FK, reset puli i migrację 8 → 9. `npm run check` używa obu URL PostgreSQL jak w [DEVELOPMENT.md](DEVELOPMENT.md), bez pomijania testów runtime. Regresje brandingu, zaproszeń, członków i logowania pozostają częścią tego polecenia.

`tests/projects-browser.mjs` sprawdza desktop i viewport mobilny 390 px, tworzenie projektów, przydziały, zadania, zmianę wykonawcy, zachowanie formularza po konflikcie, puste/błędne/ładowane widoki, opóźnione odpowiedzi, zakresy pracownika/brygadzisty/administratora oraz archiwizację. Korzysta z lokalnego Playwright/Chromium podanego przez `SITEGRID_PLAYWRIGHT_MODULE` i `SITEGRID_CHROMIUM_PATH`; nie dodaje zależności aplikacji. Nie zastępuje testów na fizycznych urządzeniach dla przyszłej bramki PWA. Zestaw Python weryfikuje zapakowane wydanie, instalator, kanał podpisany, update i blokadę niezgodnego rollbacku.

## Rozszerzenie PR13 — M08

Historyczny kontrakt M07 powyżej rozszerza [TASK_PROGRESS.md](TASK_PROGRESS.md). Schemat 10 zachowuje rekordy M07 i dodaje `in_progress`/`submitted` przez jeden endpoint komend v1. Zwykła edycja nadal nie przyjmuje statusu i nie wykonuje przejść. GET/lista zadania dodają `canProgress`, flagę bieżącego własnego wykonawstwa z rolą roboczą; dedykowany `TaskProgress` komponuje się w istniejącym widoku. Blokada firmy została przeniesiona do wspólnej infrastruktury, zachowując ten sam klucz SQL. Wydanie PR13 wymaga 10 (upgrade 0–10); kod PR12 wymagający 9 wymaga restore przy powrocie. Pełny zestaw PR12 pozostaje regresją w `npm run check`.

## Rozszerzenie PR16 — kontrahenci (M09C)

Kontrahenci są rekordami wewnątrz organizacji bez logowania, przypisanymi opcjonalnie do projektów tej samej organizacji. Historyczne projekty i zachowanie API M07/M08 pozostają ważne. Pracownicy mogą mieć wiele przydziałów projektowych; nie wprowadzamy grup/brygad. Wersja M07/M08 przewiduje **jednego wykonawcę zadania** i ta reguła pozostaje bez zmian. Godziny pracy są oddzielne od statusu/przydziału zadania; przyszły M13 wymaga przedziałów i globalnej w ramach organizacji kontroli nakładania czasu dla pracownika. Szczegółowe decyzje: [model biznesowy](CONTRACTOR_PROJECT_MODEL.md). Wdrożone w PR16: [CONTRACTORS.md](CONTRACTORS.md). Schemat 10 → 11 dodaje kontrahentów i nullable projects.contractor_id z FK tej samej firmy. GET projektu dodaje minimalny contractor lub null; POST tworzenia/edycji przyjmuje opcjonalny contractorId. Pominięcie w edycji zachowuje powiązanie, null je usuwa; nieaktywnych nie można przypisać na nowo. Wersje, audyt, role, przydziały i semantyka M08 pozostają obowiązujące. Godziny i kontrola kolizji są nadal planem M13.
