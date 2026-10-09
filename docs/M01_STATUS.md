# M01 — checkpointy i wznowienie

Branch: `feat/m01-working-foundation`, historyczna baza `59b2fb2`.
Audyt odzyskiwania 2026-10-09: wykonano `git fetch origin`; zatwierdzone wymagania odczytano z `origin/main` = `2a298b5` (PR #4), pliki `docs/audit/ROADMAP.md` i `docs/audit/ARCHITECTURE.md`. Bez pull/reset/clean/rebase/merge.
Commity implementacji: CP1 `7ccb040`, CP2 `6c79ed2`, CP3 `3ccd481`, CP4 `3c2d298`, CP5 `17e9d0c`; wszystkie wypchnięte na istniejącym branchu.

## Aktualna decyzja produktowa — 2026-10-09

**SiteGrid instalujemy TYLKO w istniejącym Debianie 13** (LXC/VM/fizyczny). Operator sam przygotowuje kontener/VM i wkleja **jedno polecenie do powłoki Debiana**. Instalator ma pobrać zweryfikowane wydanie i zainstalować samodzielnie PostgreSQL, nginx, runtime, aplikację i systemd. `ops/install-proxmox.py` usunięto; tworzenie LXC, polecenia `pct/pveam` i testy PVE nie są wymagane.

**Pozostałe wymagania do odbioru M01:** (1) prawdziwy zaufany bootstrap one-line bez wcześniejszego przesyłania artefaktu/ops; (2) uproszczone `sitegrid update` bez wymagania ręcznych flag, z bezpiecznym skonfigurowanym kanałem wydań. P2 po przerwaniu między utworzeniem katalogu stanu a zapisem znacznika naprawiony i objęty regresją poniżej. Obecne testy dotyczą dotychczasowego instalatora z ręcznym artefaktem, nie potwierdzają docelowego jednolinijkowca. **Nie deklarować, że cel jest już spełniony.** Prywatne GitHub Releases są rekomendacją, nie zatwierdzonym jeszcze wyborem kanału.

Dalsze wzmianki poniżej o testach Proxmoxa i hostowym skrypcie dokumentują **historyczny, anulowany zakres** sprzed powyższej decyzji; nie są już zadaniami ani blockerami projektu.

| Checkpoint | Status |
|---|---|
| CP1 — fundament aplikacji | DONE |
| CP2 — prawdziwe uwierzytelnianie | DONE |
| CP3 — instalator Debiana | Ręczny tryb Debian 13/systemd PASS; docelowy bootstrap one-line W TOKU; skrypt hosta Proxmox usunięty |
| CP4 — updater i rollback | DONE; testy awarii + realny update/backup/rollback PASS |
| CP5 — integracja | PASS wcześniejszych testów Debian 13 i przeglądarki; nowy docelowy one-line Debian wymaga testu |

## PR #5 — P2 i bieżący plan Debiana

- Synchronizacja: czysty branch przesunięty fast-forward z `a597b9d` do `7a1df0a` po `git fetch origin`; zachowano sześć zdalnych commitów, w tym usunięcie instalatora hosta Proxmox. Bez reset/clean/force push.
- **P2 naprawiony:** najpierw prywatny katalog roboczy i utrwalony znacznik, następnie atomowa publikacja `/var/lib/sitegrid` z `RENAME_NOREPLACE` i fsync rodzica. Awaria dokładnie po mkdir, przed write_json nie pozostawia pustego docelowego katalogu i retry dochodzi do `done`. Brak przejmowania/usuwania pozostałości lub obcych katalogów, również pustych i powstałych między preflight a publikacją; stare katalogi bez znacznika nadal wymagają inspekcji.
- **Testy sekwencyjne: 32/32 Python PASS**, zero pominięć (12 instalatora, 10 lifecycle, 10 wydania), py_compile i git diff --check PASS. Dokładna nowa regresja zawodziła na kodzie sprzed poprawki. Cztery nowe testy: okno mkdir/zapis, obcy pusty/z danymi katalog, symlink i katalog powstały po preflight. Rzeczywiste pliki/fsync/renameat2; APT/systemd/DB są atrapami. Test pakietu używa zachowanego artefaktu, nie nowego builda. Nie uruchamiano ciężkiego builda ani VM.
- Update/rollback i ich tryb manualny bez zmian; testy lifecycle nadal PASS. Odczytano aktualne M01 w ROADMAP.md i ARCHITECTURE.md po synchronizacji. Instalacja wyłącznie w gotowym Debianie 13; host Proxmoxa poza zakresem.
- **Dokładny następny krok:** zatwierdzić prywatne GitHub Releases `llit47/sitegrid` albo wskazać serwer HTTPS. Następnie przypiąć bootstrap/SHA-256 i klucz manifestu, opublikować wydanie oraz wdrożyć runner/resolver według planu w INSTALL.md. Token tylko interaktywnie/plik root 0600; wspólne źródło dla jednej komendy instalacji i `sitegrid update` bez flag. Bez decyzji kanał pozostaje niewdrożony. Po wdrożeniu test czystego Debiana bez transferu plików, przerwań, weryfikacji wydań i update/rollback.

## PR #5 — naprawa retry i decyzja o kanale wydań

- Naprawa P1 wypchnięta: `071374e`. Stan `dependencies` jest zapisywany atomowo i utrwalany przed apt-get, po weryfikacji artefaktu i potwierdzeniu. Faza nie przejmuje DB/roli SiteGrid; `started` następuje dopiero po sprawdzeniu ich nieistnienia. Retry rozpoznaje nginx pozostawiony przez własną instalację, nadal odrzucając obce zasoby, zmienioną konfigurację/vhost, inne listenery i inny artefakt.
- Test dokładnego okna przerwania po apt-get install nginx-light: PASS; na kodzie sprzed poprawki potwierdzono brak installation.json i porażkę regresji. **28/28 testów Python PASS**, zero pominięć (20 dotychczasowych + 8 nowych); py_compile i git diff --check PASS. APT/systemd są granicami mockowanymi; stan i pliki instalacji zapisuje rzeczywisty kod w prywatnym katalogu testu. Nie ponawiano ciężkich VM/buildów lokalnych; walidacja zachowanego artefaktu nie oznacza nowego builda poprawionego instalatora.
- CI poprawki `071374e`: **SUCCESS**, build nowego artefaktu i testy — https://github.com/llit47/sitegrid/actions/runs/37951411019 (drugi przebieg: https://github.com/llit47/sitegrid/actions/runs/37951407424).
- Zakres odczytu: opis PR #5, sekcja M01 ROADMAP z origin/main i pliki instalacji/aktualizacji/testów/dokumentacji. Branch bez zmiany historii. LXC: 4 GiB RAM/~3.7 GiB dostępne, dysk ~2.3 GiB wolne; testy kolejno.
- **Prosty sitegrid update: WSTRZYMANY DO DECYZJI O KANALE.** Wariant rekomendowany: prywatne GitHub Releases llit47/sitegrid, podpisany manifest kanału wskazujący wersję/artefakt/SHA-256, przypięty klucz, autoryzacja tylko do odczytu w root/0600. Alternatywa: konkretny serwer HTTPS. Nie skonfigurowano źródła, nie zmieniono flag ani trybu manualnego, nie dodano pozornego latest/main. Pytanie o wybór kanału przekazano użytkownikowi; brak odpowiedzi nie oznacza zgody.
- Projekt i brakujące elementy prawdziwego bootstrapu Proxmoxa są w INSTALL.md: publikacja przypiętego bootstrapu + podpisane wydania, prywatna autoryzacja bez wycieku sekretów, konfiguracja źródła w LXC, pobranie szablonu/dependencies świeżego PVE, integracja i rzeczywisty test bez wcześniejszego transferu ops/archiwum. Dotychczasowy skrypt tego nie zapewnia. PR #5 nadal nie jest gotowy do merge.

## Raport odzyskiwania po restarcie LXC — stan początkowy

- HEAD i zdalny branch: `c796204`; rozbieżność 0/0. CP1 `7ccb040`, CP2 `6c79ed2` oraz oba statusy są zapisane i wypchnięte. Lokalny main `59b2fb2`, zdalny main `2a298b5`; branch implementacyjny ma 4 własne commity, main 1. Wymagania PR #4 nie wymagają integracji historii.
- Reflog potwierdza kolejność CP1/CP2; stash pusty; `git fsck --no-reflogs --unreachable` nie wykazał dodatkowego utraconego commita. Brak AGENTS.md dla tego repozytorium.
- Zastano 5 zmienionych plików śledzonych: CI, .gitignore, README, app.ts, auth/routes.ts; 14 nieśledzonych: INSTALL.md, 9 plików ops, release.json, packager i 2 testy. Żaden nie został usunięty ani zastąpiony implementacją od nowa.
- Kopia 20 plików (wraz z pierwotnym statusem), patch i manifest SHA-256: prywatny katalog `.recovery/`, ignorowany przez git, oraz `/tmp/sitegrid-recovery-20261009T141201Z`. SHA-256 archiwum: `2b2ab982a33489c7dd2b97607249aa2d8e1aab8d8583016fff25054ad90a0e73`. Bez .env, kluczy, logów sesji i danych DB; kopia na trwałym dysku chroni przed kolejnym czyszczeniem /tmp.
- Poprzednia sesja `01a120c5-6ef6-7aa2-9cad-6b947a78e56f` potwierdza realną pierwszą instalację/retry na VM Debian 13/systemd, test praw dostępu i 15 testów aplikacji + 9 testów wydań. Drugi świeży test końcowego artefaktu rozpoczęto; nie ma potwierdzonego końcowego wyniku. Stary status CP3 NOT STARTED był nieaktualny.
- CP3: istnieją packager, kontrola SHA-256 i manifestu, bezpieczna ekstrakcja, instalator Debian 13, jednostki systemd, skrypt nowego nieuprzywilejowanego LXC i dokumentacja. Wersja 0.1.0 w artifacts/ oraz dist/ zachowane; kod niezacommitowany. Test Proxmoxa nie odbył się.
- CP4: brak update/rollback/status; manage.py obsługuje tylko bootstrap-admin. Są wspólne prymitywy blokady/atomowego symlinku/health, nie gotowy updater.
- CP5: istnieją testy CP1/CP2 i test wydania/instalacji CP3; brak testu update/rollback i odbioru przeglądarkowego. Nie oznaczać całego M01 jako ukończone.
- Utracone: przejściowy PostgreSQL i dwie testowe VM/klucze/logi w /tmp po restarcie; nie znaleziono utraconego kodu ani produkcyjnej DB. Testów z sesji nie przedstawiać jako powtórzonych w tej sesji.
- Zasoby: na rzeczywistym LXC 4 GiB RAM, ~3.8 GiB dostępne, swap 2 GiB niewykorzystany; dysk 18 GiB, ~6.1 GiB wolne. Sandbox pokazuje pamięć hosta (~29 GiB), więc nie wolno na tym opierać rozmiaru VM. Brak pozostałych QEMU/PG i ciężkich testów. Wszystkie buildy/testy wykonywać kolejno; maksymalnie jedna VM 2 GiB.

Niejasność dotyczy wyniku końcowego testu CP3, a nie własności/pochodzenia zmian lub danych. Rozstrzygnięcie: walidacja odzyskanego kodu i artefaktu, bez powtarzania implementacji CP1/CP2. Brak dostępnego testowego hosta Proxmox; część hostowa pozostaje niezweryfikowana.

## Co rzeczywiście działa

React/TypeScript z responsywnym logowaniem i panelem administratora, Fastify/TypeScript, produkcyjny build i serwowanie frontendu. PostgreSQL 17+; transakcyjne migracje z blokadą i weryfikacją zapisanych sum SHA-256. Liveness i readiness; oddzielna konfiguracja development/production, wymagane HTTPS origin w produkcji.

Globalne konta i credentials, Argon2id (64 MiB/3/1), sesje PostgreSQL z hashem identyfikatora i rotacją przy logowaniu. CSRF + Origin, trwałe atomowe limity IP/konta, bezpieczne komunikaty, wylogowanie z unieważnieniem sesji. Cookie HttpOnly/SameSite Strict; Secure i __Host w produkcji. Lokalny interaktywny jednorazowy bootstrap (również ochrona wyścigu), niewidoczne hasło, brak rejestracji i haseł domyślnych. Osobne uprawnienie platformowe przygotowuje model pod M02–M04.

## Końcowa walidacja CP5 (2026-10-09)

- Implementacja/testy wypchnięte: `17e9d0c`. Finalne artefakty: 0.1.0 SHA-256 `b83d1a4a9ce62054d2dd59f56133df5afe7b1c0fb436bf1de77bd635792bf5e4`; 0.1.1 `9c678e6bc5f93f3dfb51db6db7af2a6d6cdc2597405aa4376ce94e536c0f91ad`. Zgodność ops z artefaktami i brak .env/.recovery w paczkach potwierdzone. Wersje są lokalnymi artefaktami testowymi, nie opublikowanym wydaniem produkcyjnym.
- **20/20 testów Python PASS**, zero pominięć; składnia wszystkich shell/Python i browser JS, git diff --check PASS. Oba produkcyjne buildy PASS. Regresja aplikacji po odzyskaniu: 15/15 PASS (szczegóły CP3); API/UI nie zmieniano ponownie.
- Drugi świeży Debian 13/systemd, tylko jedna VM 2 vCPU/2 GiB naraz: finalny install/retry, prawa DB/runtime/config/TLS, peer auth, restart systemd i frontend HTTPS **PASS**. Dodatkowy pełny restart VM zachował konto i działającą instalację; ograniczono cache TCG do 64 MiB przed Chromium.
- Dostarczany `sitegrid bootstrap-admin` w lokalnym interaktywnym terminalu VM: **PASS**. Powtórzenie i brak terminala odrzucone; niewidoczne hasło losowe poza repo, bez echo/logowania.
- Chromium, Playwright 1.64.0, HTTPS przez loopback i lokalny certyfikat testowy: **PASS**. 401 bez sesji, błędne hasło, prawdziwe logowanie, panel, Secure/HttpOnly/SameSite Strict cookie. Ta sama sesja/konto po systemd restart, update 0.1.0→0.1.1 i rollback przez zainstalowany CLI. Logout i próba ponownego użycia starej sesji: 401. Widok mobilny 390×844 bez poziomego overflow.
- Rzeczywiste awarie: **PASS**. Uszkodzone archiwum odrzucone przed zmianami; zaufany testowy release 0.1.2 z błędem startu odtworzył poprzedni zgodny kod/readiness, z zachowanym backupem. Przerwany journal przetrwał restart i zablokował komendę; równoległa blokada także odrzuciła operację.
- Testowy release 0.1.3 ze schematem 3: **PASS**. Migracja i readiness, konto zachowane; rollback do schematu 2 odmówił przed zatrzymaniem sprawnej usługi. Backup schematu 2 odtworzono przez pg_restore do oddzielnej bazy sitegrid_restore_smoke: tożsamość/hash konta zgodne, schemat 2. Dump + trwałe metadane 0600, SHA-256 potwierdzona. Nie przywracano działającej DB i nie wykonywano downgrade.
- Fixture 0.1.2/0.1.3 są wyłącznie do testów; nie publikować. Instrukcje odtworzenia testów: INSTALL.md. Brak trace/screenshots z sekretami; klucze i poświadczenia testowe wyłącznie w chronionych plikach /tmp poza repo.
- Testowy PostgreSQL hosta oraz obie VM łagodnie zatrzymane. Dyski `/var/tmp/sitegrid-recovery-lab/{test,final}.qcow2` zachowane, razem z kontami i backupami wewnątrz VM. Przy restarcie LXC klucze /tmp mogą zniknąć; nie uruchamiać dwóch VM na tym samym dysku. Kopie oryginalnych artefaktów CP3/CP4 w ignorowanym .recovery, bez sekretów.
- Zasoby końcowe po wyłączeniu VM: rzeczywisty LXC 4 GiB RAM, ~3.7 GiB dostępne; dysk ~2.3 GiB wolne po zachowaniu obu VM i artefaktów. Nie usuwano danych w celu zwolnienia miejsca.
- CI CP4 SUCCESS: `37945221788`; status `37945228066`. CI CP5 **SUCCESS**: `37947734821` dla dokładnego SHA `17e9d0c`. Realny Proxmox nadal niezweryfikowany; nie deklarować całego M01 ani hostowego instalatora jako odebranych.

## Walidacja CP4 (2026-10-09)

- Implementacja i push: `3c2d298`; `update`, `rollback`, `status`, trwały journal, blokada, backup pg_dump, atomowe przełączenie i kontrola zgodności dokładnej historii migracji. Kontroler CLI pochodzi z aktywnego wydania.
- **20/20 testów Python PASS**, zero pominięć: 10 release + 10 lifecycle. Awaria backupu bez migracji; readiness failure z odzyskaniem tylko zgodnego kodu; nowszy schemat blokuje restart starego; rollback bez migracji; uszkodzona historia; przerwany journal; status mimo niedostępnej DB. Syntax/compile/diff PASS; build obu aplikacji PASS.
- Realna VM Debian 13 z CP3: `tests/debian-lifecycle-smoke.sh` z nowym zaufanym kontrolerem CP4 **PASS**. Uszkodzony artefakt odrzucony przed zmianami; update 0.1.0→0.1.1, root/0600 backup + pg_restore --list, readiness nowej wersji; rollback do 0.1.0, konto/hash/config/TLS zachowane, usługi aktywne. Pierwotny CP3 nie miał jeszcze komend lifecycle; finalny instalowany CLI zostanie sprawdzony przy CP5 na świeżej VM.
- Artefakt testowy 0.1.1: SHA-256 `1dfbd6cab9e249e88f4f1ada8dc2b1b1f416c75aae3965faf270545d002e800e`. Testowy PostgreSQL na hoście zatrzymany po PASS dla oszczędności RAM; dane nieusunięte. Jedna VM, testy/buildy kolejno.
- CI CP3 SUCCESS: implementacja `37944101061`, status `37944107831`. Proxmox nadal niezweryfikowany.

## Walidacja odzyskanego CP3 (2026-10-09)

- `npm run typecheck` i build PASS; `npm test` na nowym PostgreSQL 17.11: **15/15 PASS**, zero pominięć. Pierwszy test po odtworzeniu PG zgłosił brak bazy testowej; baza została utworzona, testy ponowiono, bez zmian kodu.
- Odbudowany artefakt 0.1.0: SHA-256 `9e15d5b1f3784f3b3ad16e8f91a226432be629403cbad431235221f0303979ce`; różnica zachowanego artefaktu była tylko komunikatem instalatora. **9/9 testów release PASS**, zero pominięć; shell syntax i git diff --check PASS.
- Jedna świeża VM Debian 13, oficjalny obraz sprawdzony SHA-512, QEMU TCG 2 vCPU/2 GiB, dysk poza repo. `tests/debian-install-smoke.sh`: **PASS** — rzeczywista instalacja PostgreSQL 17/systemd, retry, niezmieniona konfiguracja/TLS, prawa katalogów/sekretów, peer auth, brak superuser/DDL dla runtime, restart systemd i frontend HTTPS.
- Testowy Proxmox niedostępny: nie wykonywano pct; gotowość hostowego instalatora nadal niepotwierdzona. Bramka pełnego M01 pozostaje otwarta.
- Audyt odzyskiwania zapisany i wypchnięty: `de3d63a`.

## Testy i wyniki poprzedniej sesji

- Debian 13 w środowisku roboczym, Node 24.21.0, odizolowany PostgreSQL 17.11 pobrany i rozpakowany w `/tmp/sitegrid-pg`; bez zmian usług systemowych.
- `TEST_DATABASE_URL=postgresql://codex@127.0.0.1:55432/sitegrid_test npm run check`: typy, oba buildy i **3/3 testy PASS**, zero pominiętych. Konfiguracja produkcyjna; niedostępna baza; ponowienie migracji; odmowa readiness i migracji przy naruszonej historii.
- `npm audit`: **0 podatności** po aktualizacji `@fastify/static` do 10.1.5.
- CI CP1: **SUCCESS**, run `37935068323`.
- CP2: typy i build obu aplikacji PASS; testy z prawdziwym PostgreSQL **15/15 PASS**, zero pominiętych. Udane logowanie, błędne hasło/nieznany email, 401 bez sesji, CSRF/obcy Origin, rotacja, cookie HTTPS, logout, równoległy bootstrap i próby logowania, ponowne utworzenie serwera/puli i dwa rzeczywiste starty skompilowanego procesu API z zachowaną sesją.
- Rzeczywiste CLI przez PTY: pierwsze utworzenie konta PASS, ponowienie odrzucone, hasło niewyświetlane; uruchomienie bez lokalnego terminala odrzucone.
- CP2 `npm audit --omit=dev`: **0 podatności**. CI CP2 SUCCESS: `37936233716`; statusu CP2: `37936315231`.

## Historyczne: niezweryfikowane i blokery (zastąpione bieżącą decyzją powyżej)

**Otwarte P1 PR #5: prosty update i prawdziwy bootstrap one-line bez ręcznego transferu ops/archiwum.** Potrzebna decyzja o kanale dystrybucji i korzeniu zaufania; propozycja powyżej i w INSTALL.md. Obecny update działa wyłącznie w trybie manualnym. P1 retry jest poprawiony i objęty nową regresją, nie jest już otwartym defektem z opisu PR.

Ponadto brak rzeczywistego testu instalatora hostowego na odizolowanym Proxmox VE 9. Dotychczasowe wyniki CP1–CP5 pozostają historycznym zapisem dostępnej walidacji, nie potwierdzają pełnej bramki M01 ani nowego bootstrapu. Nowy test przerwania używa kontrolowanych atrap APT/systemd. Nie ma zatwierdzonego testowego hosta; nie wykonywano pct ani zmian istniejących CT.

## Historyczne: następny krok sprzed zmiany zakresu (już NIE wykonywać)

Uzyskać decyzję użytkownika: prywatne GitHub Releases llit47/sitegrid (rekomendowane) czy wskazany serwer HTTPS. Po wyborze ustalić miejsce publikacji i przypięty klucz weryfikacyjny; dopiero wtedy zaimplementować czytanie podpisanego manifestu przez sitegrid update, bezpieczny transport/autoryzację, konfigurację w LXC i zweryfikowany downloader bootstrapu Proxmoxa. Zachować tryb manualny, blokować brak konfiguracji/przeterminowany lub stary manifest i niezgodny artefakt przed zmianami.

Po konfiguracji/opublikowaniu przypiętego bootstrapu wykonać test na świeżym odizolowanym PVE 9 bez wcześniejszego transferu plików, z brakiem autoryzacji, uszkodzonym pobraniem, istniejącym ID i przerwaniem. Samo ponowienie dotychczasowego polecenia z ręcznie dostarczonym ops nie zamknie P1 one-line. Nie wykonywać rzeczywistego pct bez zatwierdzonego środowiska.

Nie tworzyć nowego PR; kontynuować feat/m01-working-foundation i PR #5. Nie merge, reset, clean, rebase ani Codex Review. Testy/buildy sekwencyjnie; przed cięższą walidacją sprawdzić RAM/dysk rzeczywistego LXC.
