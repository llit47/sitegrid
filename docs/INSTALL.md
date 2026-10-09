# Instalacja M01 — Debian 13 i Proxmox VE 9

Status testów znajduje się w [M01_STATUS.md](M01_STATUS.md). Skrypt hostowy Proxmoxa wymaga rzeczywistego testu na odizolowanym PVE przed uznaniem go za zweryfikowany. Nie uruchamiaj go na istniejącym CT ani z danymi produkcyjnymi.

## Artefakt dla prywatnego repozytorium

Wydanie jest przypiętym archiwum **z kodem produkcyjnym, zależnościami, migracjami i runtime Node 24.21.0** dla Linux x64/arm64. Na Debianie 13 z tą samą architekturą:

```sh
npm ci
npm run check # z TEST_DATABASE_URL do osobnej bazy
node scripts/package-release.mjs 0.1.0
```

W `artifacts/` powstaje `sitegrid-0.1.0-linux-x64.tar.gz` i SHA-256. Artefakt i katalog `ops/` dostarcz operatorowi przez uwierzytelniony kanał (np. SCP z zaufanego komputera/CI). **Sumę SHA-256 potwierdź niezależnie w uwierzytelnionym wyniku builda**. Sam checksum obok niezaufanego archiwum nie uwierzytelnia wydawcy. Bootstrap `ops/` jest kodem wykonywanym przez root, również musi pochodzić z tego zaufanego kanału. Instalator nie potrzebuje dostępu do GitHuba ani tokena repozytorium.

Nie ma jeszcze opublikowanego tagu/wydania M01; artefakt buduje operator z konkretnego, sprawdzonego commita brancha. Nie instaluj z ruchomego `main`, `latest` ani niesprawdzonego archiwum. Archiwum nie zawiera `.env`, danych, sekretów ani źródeł TypeScript wymagających kompilacji na serwerze. Argon2 używa dostarczonego natywnego modułu; instalator wykonuje jego smoke test.

## Jedno polecenie w istniejącym Debianie 13

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

## Jedno polecenie na hoście Proxmox

Wymagany Proxmox VE 9, root, Python 3, dostępne `pct/pvesm/pvesh/pveam`, pobrany oficjalny szablon Debian 13 w storage `vztmpl`, storage `rootdir`, działający bridge i sieć z dostępem kontenera do repozytoriów Debian. Szablon pobierz przez panel Proxmoxa albo `pveam`, sprawdzając dokładną nazwę z `pveam available --section system`.

```sh
python3 /root/sitegrid-installer/ops/install-proxmox.py --bundle /root/sitegrid-0.1.0-linux-x64.tar.gz --version 0.1.0 --sha256 ZAUFANA_SUMA_64_ZNAKI
```

Interaktywna konfiguracja sprawdza CT/VM ID w klastrze, storage, wolne miejsce/RAM, CPU, szablon, bridge i IPv4 (DHCP albo CIDR/brama), HTTPS origin oraz potwierdzenie `TAK`. Tworzy **wyłącznie nowy nieuprzywilejowany** CT bez nesting/Dockera i bez domyślnego hasła. Dostarcza zweryfikowany artefakt i uruchamia pełny instalator wewnątrz CT. Pierwszego administratora tworzysz później lokalnie przez `pct enter ID` i `sitegrid bootstrap-admin`.

Przy błędzie nowy CT pozostaje do inspekcji; skrypt niczego nie kasuje i odrzuca każde istniejące ID. Ponów wewnętrzny instalator w utworzonym CT, używając tego samego artefaktu i sumy; nie uruchamiaj tworzenia nowego CT w celu naprawy istniejącego.

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

Alternatywa: `--bundle https://zaufany-serwer/wydania/0.1.0/sitegrid.tar.gz`, zawsze z przypiętym `--version` i niezależnie zaufanym `--sha256`. Prywatny serwer może użyć `--curl-config /root/artifact-curl.conf` (root/0600, autoryzacja w pliku). Nie podawaj tokenów w URL, argumentach, historii powłoki ani logach. Transport nie podąża za przekierowaniami i nie wymaga publicznego GitHuba.

## Powtarzalny test instalacji

Wyłącznie **wewnątrz odizolowanej, jednorazowej VM Debian 13**, po dostarczeniu zaufanego artefaktu, katalogu ops i skryptu testowego z tego samego commita:

```sh
sudo env SITEGRID_DISPOSABLE_TEST=YES bash tests/debian-install-smoke.sh /root/sitegrid-0.1.0-linux-x64.tar.gz ZAUFANA_SUMA_64_ZNAKI 0.1.0 /root/sitegrid-installer/ops
```

Test rzeczywiście instaluje PostgreSQL i jednostki systemd, ponawia instalator, porównuje konfigurację i klucz TLS bez ich logowania, sprawdza prawa plików/rolę runtime, odmowę DDL, peer authentication, restart API i frontend przez HTTPS. Używa lokalnego certyfikatu i jawnie `--insecure` wyłącznie do tego testu. Nie uruchamia `pct` i nie zastępuje testu Proxmoxa.

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
