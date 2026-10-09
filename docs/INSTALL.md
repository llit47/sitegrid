# Instalacja M01 — gotowy Debian 13 (również w LXC)

**Zatwierdzony zakres:** operator sam przygotowuje serwer/VM/LXC Debian 13 i uruchamia w nim jedną komendę instalującą SiteGrid, PostgreSQL, zależności i usługi systemd. SiteGrid NIE tworzy kontenerów ani nie wykonuje poleceń na hoście Proxmoxa. **Docelowy bootstrap one-line nie jest jeszcze napisany; obecny instalator wymaga ręcznego dostarczenia artefaktu.** Status testów: [M01_STATUS.md](M01_STATUS.md). Nie instaluj na systemie z istniejącymi danymi/obcymi usługami bez backupu i weryfikacji.

## Artefakt dla prywatnego repozytorium

Wydanie jest przypiętym archiwum **z kodem produkcyjnym, zależnościami, migracjami i runtime Node 24.21.0** dla Linux x64/arm64. Na Debianie 13 z tą samą architekturą:

```sh
npm ci
npm run check # z TEST_DATABASE_URL do osobnej bazy
node scripts/package-release.mjs 0.1.0
```

W `artifacts/` powstaje `sitegrid-0.1.0-linux-x64.tar.gz` i SHA-256. Artefakt i katalog `ops/` dostarcz operatorowi przez uwierzytelniony kanał (np. SCP z zaufanego komputera/CI). **Sumę SHA-256 potwierdź niezależnie w uwierzytelnionym wyniku builda**. Sam checksum obok niezaufanego archiwum nie uwierzytelnia wydawcy. Bootstrap `ops/` jest kodem wykonywanym przez root, również musi pochodzić z tego zaufanego kanału. Instalator nie potrzebuje dostępu do GitHuba ani tokena repozytorium.

Nie ma jeszcze opublikowanego tagu/wydania M01; artefakt buduje operator z konkretnego, sprawdzonego commita brancha. Nie instaluj z ruchomego `main`, `latest` ani niesprawdzonego archiwum. Archiwum nie zawiera `.env`, danych, sekretów ani źródeł TypeScript wymagających kompilacji na serwerze. Argon2 używa dostarczonego natywnego modułu; instalator wykonuje jego smoke test.

## Obecny tryb instalacji w Debianie 13 — etap przejściowy

Wymagany dedykowany system z działającym systemd, root, Python 3, iproute2, dostęp do repozytoriów Debian, 2 vCPU, co najmniej 2 GiB RAM i 6 GiB wolnego miejsca. Zalecane 4 vCPU/8 GiB/40 GiB. Instalator odmawia przejęcia zastanej instalacji SiteGrid/nginx, konta systemowego, bazy lub zajętych portów.

Po transferze katalogu `ops/` do `/root/sitegrid-installer/ops` i archiwum do `/root`:

```sh
sudo bash /root/sitegrid-installer/ops/install-sitegrid.sh --bundle /root/sitegrid-0.1.0-linux-x64.tar.gz --version 0.1.0 --sha256 ZAUFANA_SUMA_64_ZNAKI
```

Instalator zapyta o origin HTTPS i potwierdzenie `TAK`. Zakłada osobnego użytkownika systemowego i rolę PostgreSQL `sitegrid`, bez superuser/BYPASSRLS i bez hasła: lokalny socket + peer authentication. Migracje i bootstrap wykonuje lokalnie operator jako PostgreSQL administrator; runtime ma ograniczone granty i nie posiada tabel. Instaluje PostgreSQL 17, własne jednostki systemd aplikacji i nginx proxy, zachowując dane bazy poza wydaniami.

Domyślnie generuje lokalny certyfikat TLS na 90 dni. Dla testów należy zaufać temu certyfikatowi na urządzeniu; docelowo zastąp `/etc/sitegrid/tls/cert.pem` (łańcuch PEM) i `key.pem` certyfikatem domeny i odnawiaj go. Klucz: root/0600. `sudo systemctl reload sitegrid-proxy` wczytuje nowy certyfikat. Skieruj DNS/nazwę w hosts na IP kontenera i otwórz skonfigurowany adres HTTPS. Bez zaufanego TLS przeglądarka pokaże ostrzeżenie certyfikatu; nie jest to gotowa publiczna konfiguracja domeny.

```sh
sudo sitegrid bootstrap-admin
# lokalny terminal, niewidoczne hasło — potem logowanie w przeglądarce
sudo systemctl restart sitegrid
sudo journalctl -u sitegrid -u sitegrid-proxy --since '10 minutes ago'
curl --fail http://127.0.0.1:3000/health/ready
```

## Docelowa instalacja — jedna komenda w Debianie

Operator samodzielnie przygotowuje **gotowy Debian 13**, loguje się do jego powłoki jako root i wkleja **jedno polecenie** z oficjalnej instrukcji wydania. Bez kopiowania plików `ops/`, archiwum, ręcznego instalowania PostgreSQL lub Node.js. Instalator ma sprawdzić OS, zasoby i istniejące usługi, bezpiecznie pobrać zweryfikowany pakiet z wybranego kanału, zainstalować zależności, PostgreSQL/nginx, SiteGrid i systemd, po czym pokazać adres WWW oraz polecenie lokalnego bootstrapu pierwszego administratora.

Jedno polecenie to *wymaganie docelowe*, nie obecnie działający link. Dokładna komenda i endpoint zostaną opublikowane dopiero po wdrożeniu/weryfikacji zaufanego bootstrapu i kanału wydań. W repozytorium i instrukcji NIE podawać fikcyjnego działającego URL. Prywatna dystrybucja może wymagać jednorazowego interaktywnego uwierzytelnienia już po uruchomieniu instalatora, ale nie wolno wkleić tokenu jako części komendy.

**Host Proxmoxa pozostaje poza zakresem SiteGrid.** Nie używamy `pct`, `pveam` ani automatycznego tworzenia LXC/VM.

## Układ i ponowienie

| Ścieżka | Własność / dane |
|---|---|
| `/opt/sitegrid/releases/<wersja>` | root, kod/Node/migracje; bez danych instalacji |
| `/opt/sitegrid/current` | atomowy symlink do wydania |
| `/etc/sitegrid/sitegrid.env` | root:sitegrid 0640; origin, ustawienia runtime/socket |
| `/etc/sitegrid/tls/key.pem` | root 0600; sekret TLS |
| `/var/lib/postgresql` | trwałe dane PostgreSQL |
| `/srv/sitegrid` | sitegrid 0750; trwały katalog aplikacji |
| `/var/lib/sitegrid` | root 0700; stan instalacji/wdrożenia i przyszłe backupy |
| `/usr/local/lib/sitegrid` | kontroler administracyjny, root |

Ponowienie tego samego instalatora weryfikuje sumę i zachowuje bazę/config. Po ukończeniu sprawdza aktywne wydanie/readiness bez ponownej instalacji. Przerwany etap można kontynuować tym samym wydaniem; pozostałe `.incoming`, `.next` lub `.tmp` powodują bezpieczne zatrzymanie do inspekcji operatora. Instalator nie usuwa takich plików w ciemno. Inna wersja wymaga aktualizatora, nie uruchomienia instalatora na istniejących danych.

Przed `apt-get` instalator zapisuje trwałą fazę `dependencies`, po kontroli świeżego systemu, integralności artefaktu i potwierdzeniu operatora. Po przerwaniu tuż po instalacji nginx ten sam artefakt może wznowić instalację. Ta faza pozwala wyłącznie na stockową konfigurację nginx i jego listenery 80/443; nadal odrzuca obce pliki/konto SiteGrid, zmienioną konfigurację/proxy i inne procesy na zajętych portach. Dopiero po sprawdzeniu braku bazy i roli SiteGrid zapisuje `started` i rozpoczyna provisioning. Istniejący nginx bez takiej rezerwacji pozostaje odrzucany.

P2: katalog stanu wraz z utrwalonym `installation.json` powstaje najpierw w prywatnym katalogu `/var/lib/.sitegrid-install-*` (0700). Instalator publikuje go atomowo jako `/var/lib/sitegrid` przez Linux `renameat2(RENAME_NOREPLACE)` i fsync katalogu nadrzędnego. Awaria po utworzeniu katalogu roboczego, przed zapisaniem znacznika nie blokuje retry: nie opublikowano jeszcze stanu ani nie uruchomiono APT. Retry tworzy nowy katalog roboczy, nie przejmuje ani nie usuwa poprzedniego. Istniejący obcy katalog docelowy, także pusty lub powstały po preflight, nie zostaje zastąpiony. Starszy pusty `/var/lib/sitegrid` bez znacznika pozostaje stanem niejednoznacznym wymagającym inspekcji operatora; instalator nie zgaduje jego pochodzenia.

Alternatywa: `--bundle https://zaufany-serwer/wydania/0.1.0/sitegrid.tar.gz`, zawsze z przypiętym `--version` i niezależnie zaufanym `--sha256`. Prywatny serwer może użyć `--curl-config /root/artifact-curl.conf` (root/0600, autoryzacja w pliku). Nie podawaj tokenów w URL, argumentach, historii powłoki ani logach. Transport nie podąża za przekierowaniami i nie wymaga publicznego GitHuba.

## Prosty updater i zaufane źródło wydań — do dokończenia

**Stan:** ręczne `sitegrid update --bundle ... --version ... --sha256 ...` działa; docelowe `sitegrid update` bez flag jeszcze NIE działa. Nie publikowano oficjalnego źródła wydań ani zaufanej komendy one-line.

Preferowany wariant do decyzji: **prywatne GitHub Releases `llit47/sitegrid`** z przypiętym kluczem weryfikacyjnym, podpisanym manifestem stabilnego kanału, wersją, architekturą i SHA-256 artefaktu. Alternatywa: kontrolowany serwer HTTPS z odpowiednio uwierzytelnionymi podpisanymi artefaktami. Prywatne GitHub Releases wymagają czytelnego przepływu tokenu tylko do odczytu, pobieranego interaktywnie i przechowywanego poza historią poleceń, zmiennymi środowiskowymi i logami (root/0600). **Brak wybranego kanału lub ważnego podpisu ma zatrzymywać instalację/aktualizację przed zmianami**, bez automatycznego przejścia na ruchomy `main/latest`.

Po konfiguracji źródła `sitegrid update` bez argumentów ma sam pobrać i zweryfikować informacje o nowej wersji, wykonać dotychczasowy backup i zgodności migracji, a następnie aktualizację z health check. Ręczny tryb z flagami pozostaje dostępną opcją awaryjną.

### Konkretny plan — bez wdrażania niezatwierdzonego kanału

1. Oficjalna instrukcja zawiera jedno polecenie z przypiętym identyfikatorem wersji bootstrapu i jego SHA-256. Mały runner Bash, oparty na narzędziach bazowego Debiana, sprawdza root/OS/zasoby i instaluje przez podpisane repozytoria APT minimalne narzędzia pobierania/weryfikacji (`ca-certificates`, `curl`, `python3`, `openssl`, `iproute2`, `util-linux`). Nie instaluje nginx przed trwałą rezerwacją istniejącego instalatora.
2. Runner pyta w terminalu o token GitHub ograniczony do `Contents: read` repozytorium `llit47/sitegrid`, bez echa i bez xtrace. Sekret trafia do chronionego pliku 0600, nigdy do argv, URL, eksportowanych zmiennych lub logów. Pobiera konkretny asset bootstrapu przez GitHub API i sprawdza przypiętą w poleceniu sumę przed wykonaniem. Nie używa `curl main | bash`; downloader nie przesyła nagłówka Authorization przy przekierowaniu na inny host.
3. Zweryfikowany bootstrap zawiera przypięty publiczny klucz Ed25519; prywatny klucz wydawcy pozostaje w konfiguracji publikacji poza repozytorium. Podpisany manifest kanału wskazuje wersję, architekturę, identyfikator assetu i SHA-256 pakietu, z terminem ważności i rosnącym numerem publikacji. Najpierw weryfikacja podpisu/metadanych, potem pakietu i bezpieczna ekstrakcja. Brak źródła, błędny podpis, przeterminowanie lub cofnięcie manifestu zatrzymuje operację.
4. Pakiet zawiera istniejące `ops/`, runtime Node i gotowy build. Bootstrap uruchamia instalator Debiana z automatycznie ustalonymi, zweryfikowanymi argumentami; ten instaluje PostgreSQL/nginx/zależności/aplikację/systemd i pyta o origin. Operator nie kopiuje żadnych plików. Źródło, kanał, klucz i ścieżka chronionego tokenu są zapisywane poza wydaniem w konfiguracji root, bez wartości sekretu w logach.
5. `sitegrid update` bez flag używa tego samego resolvera i konfiguracji. Brak nowej wersji oznacza jawny komunikat; brak konfiguracji oznacza błąd, bez fallbacku do `latest/main`. Zweryfikowane wydanie trafia do obecnego mechanizmu blokady, backupu, kontroli migracji, atomowego przełączenia i readiness. Kompletny manualny zestaw `--bundle/--version/--sha256` oraz zgodny rollback pozostają dostępne.
6. Po zatwierdzeniu kanału, klucza i publikacji bootstrapu: test jednej komendy na czystym Debianie 13/systemd bez uprzedniego transferu, odmowa błędnej autoryzacji/podpisu/sumy i starego manifestu, przerwania/retry oraz update/rollback bez utraty konta. Bez operacji na hoście Proxmoxa.

Do decyzji: zatwierdzenie prywatnych GitHub Releases jako wspólnego kanału instalacji i aktualizacji (alternatywa: wskazany serwer HTTPS). Powyższy runner/resolver i publikacja nie są jeszcze zaimplementowane; nie podajemy działającej komendy ani URL przed ich weryfikacją.

## Powtarzalny test instalacji

Wyłącznie **wewnątrz odizolowanej, jednorazowej VM Debian 13**, po dostarczeniu zaufanego artefaktu, katalogu ops i skryptu testowego z tego samego commita:

```sh
sudo env SITEGRID_DISPOSABLE_TEST=YES bash tests/debian-install-smoke.sh /root/sitegrid-0.1.0-linux-x64.tar.gz ZAUFANA_SUMA_64_ZNAKI 0.1.0 /root/sitegrid-installer/ops
```

Test rzeczywiście instaluje PostgreSQL i jednostki systemd, ponawia instalator, porównuje konfigurację i klucz TLS bez ich logowania, sprawdza prawa plików/rolę runtime, odmowę DDL, peer authentication, restart API i frontend przez HTTPS. Używa lokalnego certyfikatu i jawnie `--insecure` wyłącznie do tego testu. Nie uruchamia `pct`; test hosta Proxmox nie jest wymagany, ponieważ SiteGrid instaluje się tylko w Debianie.

## Aktualizacja, rollback i stan

Dostarcz przypięty artefakt oraz niezależnie zaufaną SHA-256, tak samo jak przy instalacji:

```sh
sudo sitegrid status
sudo sitegrid update --bundle /root/sitegrid-0.1.1-linux-x64.tar.gz --version 0.1.1 --sha256 ZAUFANA_SUMA_64_ZNAKI
sudo sitegrid rollback
# wcześniejsza, już pomyślnie wdrożona wersja:
sudo sitegrid rollback --version 0.1.0
```

Update pyta o `TAK`; `--yes` jest jawnym potwierdzeniem automatyzacji. Obsługuje też HTTPS i `--curl-config`, z tymi samymi ograniczeniami transportu co instalator. Sprawdza manifest, architekturę, PostgreSQL i sumy wszystkich już wykonanych migracji przed zatrzymaniem aplikacji. Nie nadpisuje istniejącego wydania o innej sumie. Zatrzymuje API, tworzy chroniony backup `pg_dump` w `/var/lib/sitegrid/backups` (root/0600), sprawdza jego format, wykonuje transakcyjne migracje i granty, atomowo przełącza kod, restartuje systemd i czeka na readiness właściwej wersji. Konfiguracja, TLS i baza pozostają poza release.

Rollback dotyczy kodu, zachowuje obecną DB i nie uruchamia migracji ani restore. Domyślnie wybiera wydanie aktywne bezpośrednio przed aktualizacją. Przy niezgodności historii/schematu odmawia **przed zatrzymaniem działającej usługi**. Obecna aplikacja wymaga dokładnej zgodności historii migracji; szerszy zakres w manifeście sam w sobie nie uzasadnia rollbacku do starego kodu.

Stan operacji jest atomowo zapisywany w `/var/lib/sitegrid/deployment.json`; blokada zapobiega równoległym instalacjom/update/rollback. `sitegrid status` można odczytać także podczas wdrożenia: wskazuje current, rzeczywisty stan systemd, readiness, schemat i journal. Jeśli nowe wydanie zawiedzie, kontroler uruchamia poprzedni kod wyłącznie przy zgodności z rzeczywistą DB; w przeciwnym razie raportuje stan usługi i backup potrzebny do kontrolowanego odzyskania. Nigdy automatycznie nie przywraca DB i nie wykonuje downgrade schematu.

Po awaryjnym restarcie niezakończony journal blokuje kolejne zmiany. Operator sprawdza `sitegrid status`, `journalctl -u sitegrid`, backup i historię migracji, wstrzymuje zapisy i uzgadnia kontrolowany restore (jeśli potrzebny). Po zweryfikowanym odzyskaniu zachowuje kopię journal poza repo i dopiero oznacza jego fazę `recovered`. Nie usuwa w ciemno journal, `.incoming`, `.next` ani `.tmp`. Sam powrót symlinku nie odtwarza danych. Backupy mogą zawierać dane uwierzytelniania; przechowuj je poza repo, ogranicz dostęp i eksportuj do chronionej kopii poza hostem.

Test cyklu w **jednorazowej VM**: `SITEGRID_DISPOSABLE_TEST=YES bash tests/debian-lifecycle-smoke.sh BUNDLE SHA256 NOWA_WERSJA`. Tworzy konto syntetyczne i porównuje jego zachowanie, odrzuca uszkodzony artefakt, wykonuje prawdziwy backup/update/rollback i sprawdza konfigurację. Przy testowaniu kontrolera CP4 na wcześniejszym roboczym CP3 można podać czwarty argument: zaufany katalog nowych `ops`; finalna instalacja M01 używa CLI z aktywnego wydania.

Każdy backup ma także chroniony plik JSON z wersją kodu, schematem i SHA-256 dumpa; metadane pozostają dostępne po zastąpieniu bieżącego journal przez późniejszą operację. Odtworzenie PostgreSQL wymaga osobnej kontrolowanej procedury i wstrzymania zapisów; komenda rollback tego nie wykonuje.

## Końcowy odbiór na jednorazowym Debianie

Przygotuj świeżą VM Debian 13 z 2 vCPU/2 GiB RAM, systemd i dyskiem 16 GiB. Używaj wyłącznie portów loopback. Nie uruchamiaj drugiej VM ani builda podczas ciężkiego testu. Dostarcz finalne artefakty, zaufane ops i skrypty tests. Kolejno:

1. `tests/debian-install-smoke.sh` z finalnym 0.1.0 — instalacja/retry/prawa/systemd/HTTPS.
2. `tests/bootstrap-deployed.py --ssh-key KLUCZ_TESTOWEJ_VM --known-hosts HOSTS_TESTOWEJ_VM --credentials /tmp/sitegrid-test-credentials.json` — interaktywny lokalny CLI, jednorazowość, odmowa bez terminala. Tylko SSH do `127.0.0.1:12222`; hasło losowe, plik 0600 poza repo.
3. `tests/deployed-browser-smoke.mjs` z Chromium/Playwright — rzeczywiste logowanie, cookie Secure, restart systemd, update 0.1.0→0.1.1 i rollback przez zainstalowany `sitegrid`, zachowanie tej samej sesji, wylogowanie/unieważnienie i widok mobilny. Chromium przekierowuje nazwę testową do loopback `12443`; `ignoreHTTPSErrors` dotyczy wyłącznie lokalnego certyfikatu testowego.
4. `tests/make-release-fixture.py BUNDLE_0.1.1 SHA256 readiness` oraz wariant `schema` — lokalne artefakty **wyłącznie testowe** 0.1.2/0.1.3; pierwszy odmawia startu, drugi rozszerza schemat testową tabelą. Nie są wydaniami produkcyjnymi.
5. `tests/debian-failure-smoke.sh BAD_BUNDLE BAD_SHA SCHEMA_BUNDLE SCHEMA_SHA` w VM — realny błąd readiness i odzyskanie starego kodu, journal po restarcie, blokada równoległej operacji, upgrade schematu, zablokowany rollback bez zatrzymania działającej usługi, konto zachowane; restore backupu do oddzielnej bazy testowej i porównanie tożsamości.

Każdy skrypt wymaga `SITEGRID_DISPOSABLE_TEST=YES`. Skrypty shell działają wewnątrz VM jako root; bootstrap i browser na komputerze testującym. Dla browser ustaw `SITEGRID_TEST_CREDENTIALS`, `SITEGRID_TEST_SSH_KEY`, `SITEGRID_TEST_KNOWN_HOSTS`, `SITEGRID_TEST_UPDATE_SHA`; opcjonalnie `SITEGRID_PLAYWRIGHT_MODULE` wskazuje lokalny `playwright/index.mjs`. Instalacja Playwright/Chromium jest zależnością środowiska odbioru, nie runtime serwera. Sesji/haseł nie zapisuj do repo, logów ani trace. Stan Proxmoxa opisuje osobno M01_STATUS.md; powyższe testy go nie zastępują.
