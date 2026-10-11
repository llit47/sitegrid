# PR22 — podzadania, przydział i niezależny postęp

Kontrakt rozszerza [PR21](TASK_BACKLOG.md) i [Task Management v2](TASK_MANAGEMENT_V2.md). Backend `apps/server/src/subtasks/` i React `apps/web/src/subtasks/` pozostają modułami monolitu. M08 korzysta z tych samych zadań, komend i receipts. PR22 nie obejmuje komentarzy i zdjęć; rozszerza go [PR23 online](TASK_COMMENTS_MEDIA.md), schema14, bez PDF i trwałej kolejki offline.

## Hierarchia i migracja 12 → 13

Nowa `013_subtasks.sql` dodaje `tasks.parent_task_id` (NULL dla rodziców) i generowany `hierarchy_root`. Dotychczasowe rekordy pozostają rodzicami: zachowane ID, projekt/firma, wykonawca lub backlog, autor, treści, statusy, wersje, czasy, audyt i receipts. Historyczne migracje i ich checksumy pozostają bez zmian.

`task_parent_contexts` przechowuje wyłącznie firmę, projekt, ID i aktualny tytuł rodzica oraz techniczną flagę korzenia. Złożony FK wskazuje zadanie z generowaną flagą korzenia równą true; FK dziecka wskazuje tę projekcję w **tej samej firmie i projekcie**. CHECK zabrania własnego ID jako rodzica. Klucze i flagi wymuszają maksymalnie jeden poziom oraz brak cykli nawet bez triggerów aplikacyjnych. Trigger blokuje zmianę rodzica istniejącego rekordu, a projekcja jest aktualizowana atomowo po zmianie tytułu rodzica. Nie zmienia wersji ani historii dzieci. Nie ma przenoszenia istniejących zadań między rodzicami.

Wszystkie funkcje są invoker, bez SECURITY DEFINER i bez BYPASSRLS. Projekcja ma ENABLE/FORCE RLS oraz ograniczone SELECT/INSERT/UPDATE; runtime nie ma DELETE/TRUNCATE. Trigger wymaga zgodności projekcji z prawdziwym rodzicem. Dodatkowo RLS odczytu audytu zadaniowego filtruje zdarzenia po aktualnie dostępnym zadaniu, aby surowy SQL nie ujawniał rodzeństwa. Audyt innych modułów zachowuje dotychczasowy zakres. Indeksy wspierają listę dzieci i historię postępu.

## Dostęp i postęp

Administrator firmy (bez dodatkowej roli kierownika), kierownik i brygadzista zarządzają wszystkimi hierarchiami własnej aktywnej firmy, również bez przydziałów projektowych. Administrator platformy nie otrzymuje wyjątku. Pracownik czyta wyłącznie zadania/podzadania przypisane do własnego aktywnego członkostwa. Sam przydział rodzica nie udostępnia dzieci.

Przydział dziecka daje minimalne `parent: {id,title}` oraz istniejący kontekst projektu. Nie daje GET pełnego rodzica, opisu/statusu/wykonawcy rodzica, listy rodzeństwa, historii innych zadań ani agregatów. Tytuł rodzica pozostaje jawnie elementem udostępnianego kontekstu. RLS projekcji odczytuje jedynie dozwolone dzieci; polityka zadań nie odczytuje projekcji, unikając rekurencji. Cofnięcie przydziału/roli/członkostwa blokuje kolejne odczyty i replay M08.

Dziecko może mieć NULL wykonawcę tylko przy `planned` (Backlog). Przydział/zmiana/cofnięcie korzystają z endpointu PR21, świeżych kontroli po blokadzie firmy, CSRF/Origin i `expectedVersion`. Nieaktywne/obce członkostwo jest odrzucane; historyczny przydział nie jest kasowany. Rozpoczęte/zgłoszone zadanie nie zmienia wykonawcy (`TASK_ASSIGNMENT_LOCKED`).

Każde dziecko ma niezależny `planned → in_progress → submitted`, wersję, idempotentną komendę, receipt i audyt M08. Wykonawca działa tylko za siebie; administrator bez roli wykonawczej nie raportuje postępu. Postęp dziecka nie zmienia statusu, wersji ani wykonawcy rodzica. Nie ma automatycznego zamknięcia ani odbioru.

## API i listy

- `POST .../projects/:projectId/tasks/:taskId/subtasks` przyjmuje `title`, opcjonalne `description` i `assigneeMembershipId`; projekt i rodzic wynikają wyłącznie ze ścieżki. Sukces 201 po COMMIT. Próba utworzenia wnuka: 409 `SUBTASK_DEPTH_LIMIT`. Niedostępny/obcy rodzic: 404 (lub 403 dla niedostępnej firmy).
- `GET .../tasks/:taskId/subtasks` jest listą całej hierarchii wyłącznie dla zarządzających. Pracownik, także wykonawca rodzica, otrzymuje 404. Dziecko nie ma listy własnych dzieci.
- `GET .../tasks/:taskId/progress-history` sprawdza bieżący dostęp i zwraca wyłącznie zdarzenia postępu danego zadania: stan, wersję i czas. Nie udostępnia surowych szczegółów audytu lub danych kont.
- Dotychczasowe GET/edycja/przydział/komendy obejmują również podzadania. GET listy/detalu dodaje `parent` (NULL dla głównego zadania). Zarządzający otrzymuje dla rodziców `subtaskProgress: {total,planned,inProgress,submitted}`; pracownik nie otrzymuje tego pola.

Firmowa lista, pulpit, wyszukiwanie, filtry i paginacja pozostają **płaskim autoryzowanym zbiorem**, z każdym ID dokładnie raz. Filtry obejmują również dzieci (np. backlog lub wykonawcę dziecka). Agregat rodzica to osobna informacja, nie dodatkowe zadania ani status rodzica. UI po rozwinięciu hierarchii ukrywa te same dzieci z płaskiej listy; jeśli rodzic nie znajduje się na stronie/nie pasuje do filtra, dziecko ma samodzielną kartę z minimalnym kontekstem.

## UI, M08 i M10

Pod rodzicem jest agregat i rozwijana lista dzieci, szybkie dodawanie z opisem/wykonawcą, przydział oraz istniejące akcje M08 i historia postępu. Projektowy widok zachowuje edycję tytułu/opisu przez dotychczasowy formularz. Pracownik ma samodzielne własne podzadania bez przycisku hierarchii lub liczników. Formularze, ładowanie, błędy, potwierdzenie, ochrona szkiców i dotykowe przyciski działają przy 1280/768/390 px. Nierozstrzygnięte komendy pozostają zamontowane; potwierdzenie innego dziecka nie może zniszczyć operationId lub zablokować jego retry. Przydział unieważnia snapshot tylko właściwego projektu, zgodnie z PR21.

Snapshot M10 zachowuje **format 1**, SHA-256, limit 500 rekordów zadań (rodzice i dzieci razem), 2 MiB, REPEATABLE READ oraz IDB v2. Dodaje opcjonalne `parent` i zarządcze `subtaskProgress`. Nowy klient odczytuje także starsze snapshoty bez tych pól. Walidator sprawdza dozwolone pola kontekstu, cykle/głębokość widocznej hierarchii i zgodność agregatów z pełnym zakresem. Snapshot pracownika zawiera tylko własne rekordy i minimalny tytuł rodzica; brak rodzica w tablicy jest dozwolony. Nie pobiera rodzeństwa w celu uzupełnienia hierarchii. Starszy ścisły klient M10 odrzuci nowe rozszerzone snapshoty bez resetu danych; zgodny rollback wymaga kodu obsługującego schemat 13 i te pola. Offline pozostaje odczytem stanu, bez historii postępu/komend, z istniejącym limitem 24 h i brakiem remote wipe.

## Paczka, update i ograniczenia

Kontrakt `release.json`: PostgreSQL **13**, upgrade **0–13**, wersja produktu nadal 0.1.1. Paczka zawiera migrację 013, moduły podzadań i wersjonowany build PWA. Update robi backup przed migracją. Rollback do PR21/schema 12 jest blokowany przed zatrzymaniem usługi; powrót wymaga kontrolowanego restore DB sprzed migracji. Nie ma SQL downgrade. Dotychczasowy rollback między zgodnymi paczkami pozostaje objęty regresją.

Ograniczenia: jeden poziom i niezmienny rodzic, brak odbioru/automatycznego zamknięcia, brak zmiany wykonawcy po rozpoczęciu, brak trwałych zapisów offline. Offset paginacji nie daje niezmiennego snapshotu przy równoległych insertach (PR21). Physical Android/iOS oraz świeży Debian/systemd pozostają odbiorem manualnym; viewport i testy lokalnej paczki ich nie zastępują. Ten PR nie tworzy tagu ani release'u.

## Wyniki lokalnej weryfikacji

Node 24.21.0, PostgreSQL 17.11, runtime bez superuser/BYPASSRLS/CREATEROLE. `npm run check`: **193/193**, bez pominięć (typecheck, lint, build i pełny zestaw API/SQL/migracji/M08/M10). Nowy zestaw podzadań: **12/12**, w tym populated schema 12 → 13, porównanie wszystkich wcześniejszych tabel/checksumów i replay receipt po migracji.

Wszystkie **dziewięć** zestawów Playwright przeszło: podzadania (1280/768/390 px, screenshoty, granice kart i współbieżny retry), PR21/listy, workspace, M08, M10/IndexedDB, PWA, projekty, kontrahenci i branding. M10 sprawdza też przypisane dziecko z niedostępnym rodzicem/rodzeństwem w rzeczywistym IndexedDB, lokalnym viewerze i po zamknięciu/otwarciu offline, desktop/mobile.

Zbudowano rzeczywistą paczkę Linux x64 do lokalnego katalogu artefaktów. Python: **60/60**, bez pominięć, w tym kompletność paczki, update 12 → 13 z backupem i blokada rollbacku 13 → 12 przed zatrzymaniem usługi oraz zgodny rollback. Walidacje shell/Python/JS i `git diff --check` przechodzą. Testy cyklu instalatora używają syntetycznych fixture; w tym PR nie wykonywano świeżej instalacji na fizycznym Debianie/systemd ani odbioru telefonu Android/iOS.
