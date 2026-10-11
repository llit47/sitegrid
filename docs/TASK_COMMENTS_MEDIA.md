# PR23 — komentarze i prywatne zdjęcia (online)

Kontrakt rozszerza [zadania v2](TASK_MANAGEMENT_V2.md) i [podzadania](SUBTASKS.md). Moduły monolitu: `apps/server/src/task-comments/` i `apps/web/src/task-comments/`. Wersja produktu pozostaje **0.1.2**, zgodnie z aktualnym main; PR nie tworzy tagu ani wydania. PostgreSQL schema **14**, upgrade **0–14**.

## Historia i dostęp

Chronologiczna dyskusja należy do pojedynczego zadania lub podzadania. Dostępni administrator firmy, kierownik i brygadzista mogą czytać/pisać; pracownik wyłącznie na swoim aktualnym przydziale. Odczyt obejmuje wszystkich autorów. Sam przydział dziecka nie daje dyskusji rodzica, rodzeństwa ani ich plików. Administrator platformy nie ma wyjątku. Aktywne konto/członkostwo/firma/rola, sesja i właściwe zadanie są sprawdzane przy każdym żądaniu, również przy ponowieniu zapisu i odczycie pliku. Odcięcie dostępu blokuje następne żądania serwera. Archiwum zachowuje odczyt; nowe komentarze są zabronione, odczyt/replay wcześniejszego potwierdzenia jest dozwolony.

`014_task_comments_media.sql` dodaje `task_comments` i `task_comment_media`, tenantowe FK i ENABLE/FORCE RLS. Historyczne migracje/checksumy/dane pozostają zachowane. FK autora wskazuje historyczne członkostwo, a wyświetlana nazwa jest utrwalana przy tworzeniu; dezaktywacja autora nie ukrywa komentarzy. Treść i media są niezmienne, runtime ma tylko SELECT/INSERT. Triggery blokują UPDATE/DELETE oraz dołączanie fotografii w późniejszej transakcji. Odroczony trigger wymaga pełnej zadeklarowanej liczby zdjęć przed COMMIT. Audyt `task_comment_created` i `task_media_attached` wskazuje zadanie, projekt, komentarz i metadane pliku; odczyt audytu również filtruje aktualne zadanie.

## API i atomowość

Baza: `/api/organizations/:id/projects/:projectId/tasks/:taskId/comments`.

- GET: 20 komentarzy, `comments` i `nextAfter`; następna strona `?after=<comment UUID>`. Porządek `(created_at,id)` i porównanie kursora w PostgreSQL zachowują mikrosekundy oraz stabilność przy nowych insertach.
- POST multipart: `commentId` (UUID klienta), opcjonalny `text` (4000 znaków), do 5 powtórzonych części `photos`. Tekst, zdjęcia lub oba. Puste żądanie jest odrzucane. Sukces 201 dopiero po COMMIT; replay 200. Ten sam ID i treść/znormalizowane fotografie dają ten sam komentarz, zmieniony payload daje 409. Replay zawsze sprawdza aktualny dostęp.
- GET `.../media/:mediaId/thumbnail` i `.../media/:mediaId/original`: uwierzytelniony JPEG, aktualne uprawnienia do tego konkretnego zadania, `private, no-store`, `nosniff`, same-origin CORP. Brak publicznego katalogu statycznego, redirectu, signed URL lub trwałego URL CDN. Nieuprawnione ID zadania/pliku nie ujawnia istnienia rekordu.

Zachowane cookie, Origin/CSRF i transakcyjny kontekst firmy. Mutacje blokują firmę tą samą blokadą co pozostałe moduły; credentials są ponownie sprawdzane po uploadzie. Dodatkowa współdzielona blokada PostgreSQL `sitegrid.media` obejmuje upload/publikację/COMMIT. Operacje backup/cleanup/restore używają jej wyłącznie. Do 2 równoczesnych uploadów na proces, po 60 s, bounded multipart, do 10 MiB na plik i **50 MiB całego żądania łącznie z narzutem multipart**. Dekodowanie jest sekwencyjne, maksymalnie 40 mln pikseli i 12000 px na bok; odrzucane animacje. Limity globalne wymagają jednego procesu aplikacji, zgodnie z obecnym wdrożeniem.

`@fastify/multipart` jest jedyną nową zależnością. Faktyczne sygnatury, MIME i dekodowanie pełnych pikseli przez istniejący `sharp` muszą się zgadzać. JPEG/PNG/WebP są obracane zgodnie z orientacją, spłaszczane na białym tle i kodowane ponownie jako JPEG, bez EXIF/GPS/ICC i końcowych obcych danych. „Original” oznacza pełną rozdzielczość po normalizacji, nie surowy plik wejściowy. Miniatura mieści się w 480×480 px. HEIC/HEIF ma jawny błąd i instrukcję eksportu JPEG; nie uruchamiamy jego dekodera. Uszkodzenie, zbyt duży plik, dimensions i brak miejsca mają jawne błędy.

## Magazyn

Produkcja: **`/srv/sitegrid/files`**, prywatny katalog `sitegrid:sitegrid` 0700, pliki 0600, poza release. Zarządzane backupy używają tego stałego katalogu; produkcja odrzuca inny FILES_ROOT. Development/test mogą ustawić FILES_ROOT. Układ: `<losowy media UUID>/original.jpg`, `thumbnail.jpg`; `.staging/<losowy UUID>` jest roboczy. Nazwa przesłana przez klienta nigdy nie staje się ścieżką. Odczyt sprawdza katalogi, NOFOLLOW, typ/rozmiar pliku i SHA-256 przed wysłaniem. PostgreSQL przechowuje relacje, kolejność, rozmiary, wymiary i SHA-256 obu wersji; brak blobów zdjęć.

Wszystkie zdjęcia są walidowane przed publikacją. Pliki i katalogi są fsyncowane i przenoszone atomowo przed zapisem referencji. Błąd któregoś zdjęcia, audytu lub COMMIT nie publikuje części komentarza. Awaria między publikacją plików a DB może pozostawić osierocone pliki; **nie usuwamy ich po niejednoznacznym wyniku COMMIT**, ponieważ transakcja mogła zostać zatwierdzona. Bezpieczny cleanup sprawdza aktualne referencje pod blokadą. Przed uploadem wymagane 256 MiB rezerwy oraz zapas na staging/normalizację. Brak miejsca/awaria zapisu nie daje sukcesu. Media przeżywają restart, update i rollback zgodnego kodu.

## Backup i kontrola integralności

Zarządzany update nadal zatrzymuje usługę i robi backup **przed** migracją. Dla DB <14 zachowany dotychczasowy `.dump` + metadata JSON (brak mediów w tych schematach). Dla schema14 powstaje samowystarczalny katalog `/var/lib/sitegrid/backups/<operation>.backup`:

- `database.dump`: pg_dump custom;
- `manifest.json`: historia/checksumy schematu, checksum dumpu, kompletna lista referencji i sum plików;
- `files/<media UUID>/original.jpg` i `thumbnail.jpg`: niezależne kopie każdego pliku ze snapshotu DB.

Proces właściciela otwiera transakcję REPEATABLE READ, blokuje publikację/cleanup, eksportuje snapshot, odczytuje metadane i przekazuje **ten sam snapshot** do `pg_dump`. Nie liczymy na dwa niezależne odczyty. Niezmienne pliki są sprawdzane i kopiowane, archiwum sprawdzane przez `pg_restore --list`, dane/manifest fsyncowane. Dopiero kompletny wynik jest przemianowany z `.incoming` na `.backup`. Brak/uszkodzenie pliku, dump failure albo brak miejsca blokuje sukces i migracje. `.incoming` oznacza niekompletną próbę, nigdy backup do restore. Kopię należy wynieść na osobny nośnik z prawami chroniącymi prywatne dane; zachować cały katalog, nie sam dump.

Root CLI potrzebuje odczytu prywatnych plików i owner DB: otwiera jedną sesję peer jako effective UID postgres, wraca do root, a pg_dump/pg_restore działają jako postgres z odziedziczonymi deskryptorami chronionego dumpu. Runtime HTTP nie importuje modułu operacyjnego ani nie używa owner URL.

```sh
systemctl stop sitegrid.service
sitegrid backup
sitegrid media-check
sitegrid media-check --cleanup
systemctl start sitegrid.service
sitegrid status
```

`media-check` weryfikuje każdą referencję, rozmiar i SHA-256; błąd dla brakujących/uszkodzonych plików. Zwraca wolne bajty, niepowiązane UUID i pozostałości stagingu. Cleanup kasuje wyłącznie niepowiązane katalogi/staging starsze niż 24 h, pod wyłączną blokadą; nowe osierocone pliki pozostają do następnej inspekcji. Nie dotyka referencji ani katalogu backupów. Backupy są kopiami, bez hard linków; cleanup live storage nie zmienia retencji i nie psuje starych kopii. Retencja backupów pozostaje świadomą decyzją operatora. Usługa ma być zatrzymana dla ręcznych operacji; sprawdzenie aktywnej usługi blokuje komendę. Monitorować wynik backup/check i wolne miejsce; brak automatycznego harmonogramu/retencji.

## Sprawdzona procedura restore schema14

1. Zatrzymać usługę. Zachować bieżącą DB i files jako materiał do odzyskania; nie nadpisywać ich. Wskazać kompletny `.backup` i zainstalowany release obsługujący identyczną historię migracji schema14. Zachować instalację `/etc/sitegrid`, marker/stany `/var/lib/sitegrid` i istniejącą runtime rolę sitegrid.
2. Przygotować **nową pustą bazę sitegrid**, z owner postgres (np. zachować starą przez rename z osobnego połączenia do postgres), oraz pusty `/srv/sitegrid/files` (stary katalog przenieść poza docelową ścieżkę). Nigdy nie używać `DROP` działającej bazy jako kroku automatycznego. Sprawdzić, że wybrany backup pozostaje poza przenoszonym katalogiem files.
Przykład kroku 2 (nazwy zachowanych danych mają być wolne; polecenia odmawiają nadpisania):

```sh
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c 'ALTER DATABASE sitegrid RENAME TO sitegrid_before_restore;'
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c 'CREATE DATABASE sitegrid OWNER postgres;'
mv -T -n /srv/sitegrid/files /srv/sitegrid/files.before_restore
install -d -m 0700 -o sitegrid -g sitegrid /srv/sitegrid/files
```

3. Wykonać `sitegrid restore --backup /BEZPIECZNA_SCIEZKA/operation.backup`. Komenda sprawdza cały dump i zdjęcia **przed** zmianami, wymaga pustych miejsc docelowych i identycznego schematu/checksumów. Kopiuje/fsyncuje pliki, uruchamia pg_restore `--single-transaction --exit-on-error`, porównuje odtworzone referencje z inventory, sprawdza wszystkie pliki, przywraca prawa sitegrid oraz granty i kontroluje zgodność aktywnego kodu. Sukces zamyka journal jako recovered; usługa pozostaje zatrzymana. Błąd pozostawia usługę zatrzymaną i materiał do analizy; ponowienie wymaga ponownie pustego miejsca docelowego, zachowując nieudaną próbę.
4. `sitegrid media-check`, następnie `systemctl start sitegrid.service` i `sitegrid status`. Zalogować się jako administrator firmy i przypisany pracownik, sprawdzić dyskusję oraz miniaturę/original. Uzgodnić operacje M08 wykonane po dacie backupu; nie odtwarzać automatycznie utraconych receipts. Epoka synchronizacji/pełne konflikty pozostają M12/M15.

Test automatyczny używa rzeczywistych osobnych baz PostgreSQL 17, pg_dump/pg_restore i fotograficznych fixtures. Odtwarza komentarze, obie wersje zdjęć, relacje i SHA, porównuje rekordy, potwierdza odporność zatrzymanej kopii na cleanup oraz odmowę uszkodzonej/niekompletnej kopii i niepustego celu. To sprawdzony przepływ danych, nie deklaracja odbioru świeżego Debiana/systemd.

Restore sprzed update 13→14 nadal dotyczy istniejącego DB-only dumpu i **kodu schema13**. Rollback schema14→13 jest blokowany przed zatrzymaniem działającej usługi; brak downgrade SQL. Paczka zawiera migrację014, wszystkie moduły i przypięty dekoder. Zgodny rollback schema14 nie zmienia magazynu.

## UI i granica offline

W istniejących kartach/detalach zadań i hierarchii jest rozwijana dyskusja, paginacja, autor/czas, gallery multiple/camera capture, podgląd/usunięcie wybranych plików, postęp uploadu, modal pełnego zdjęcia, empty/loading/error i potwierdzenie serwera. Nie dodajemy list zadań. Formularz chroni szkic, po recoverable error zachowuje tekst/Files; niepewne potwierdzenie zamraża payload i proponuje replay tego samego UUID. Draft trwa wyłącznie w pamięci aktualnej strony, survives reconnect, znika po zamknięciu strony, zmianie konta lub zakresu firmy. Nie wysyła się sam i nie jest trwałą kolejką offline.

Dyskusje/media są **online-only**. PWA offline usuwa ich widok; snapshot M10 format1/IDBv2, cache allowlist i receipts M08 pozostają bez zmiany. Nie ma komentarzy/zdjęć w IDB, localStorage ani service-worker caches. Physical Android/iOS, HEIC eksport z konkretnych galerii i świeży Debian/systemd wymagają manualnego odbioru. Brak edycji/usuwania, HEIC dekodera, chmury, offline uploadów, M11/M12 i planów PDF. RPO zależy od częstości kopii; RTO od rozmiaru DB/files i przepustowości, bez deklaracji wartości z testu małej fixture.

## Lokalna weryfikacja PR23

Node 24.21.0, PostgreSQL 17.11, rzeczywisty runtime `sitegrid` bez superuser/BYPASSRLS. `npm run check`: **212/212**, zero skips (typecheck, lint, build, API/SQL/migracje, M08/M10). Nowy zestaw PR23: **19/19**, w tym populated13→14, aktualne revocations, FORCE RLS/FK, odroczona kompletność zdjęć, chunked50MiB, rollback/interruption, brak miejsca, integralność, real pg_dump/pg_restore z fotografiami i retained-copy checks.

Wszystkie **10** zestawów Playwright przeszło: PR23 (1280/768/390 px), podzadania, zadania/backlog, workspace, M08, M10/IndexedDB, PWA, projekty, kontrahenci i branding. PR23 sprawdza camera/gallery inputs, wiele zdjęć, previews/full-size, błędy i zachowane szkice, utraconą odpowiedź/idempotentny retry, reconnect, child isolation i archiwum. Dotychczasowy M08 sprawdza brak przycisków postępu w obrębie `.task-progress`, niezależnie od nowego przycisku dyskusji; zakres asercji uprawnień nie zmienia się.

Rzeczywista paczka Linux x64 0.1.2: Python **66/66**, zero skips; migracja014, wszystkie moduły, bundled multipart/Fastify boot, sharp normalizacja i miniatura z własnym runtime. Update13→14, blocked rollback14→13 i compatible rollback przechodzą. Walidacje shell/Python/JS i `git diff --check` przechodzą. Artefakty/screenshoty lokalne poza repo; brak tagu, Release lub wdrożenia produkcyjnego.
