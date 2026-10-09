# M01 — checkpointy i wznowienie

Branch: `feat/m01-working-foundation`, historyczna baza `59b2fb2`.
Audyt odzyskiwania 2026-10-09: wykonano `git fetch origin`; zatwierdzone wymagania odczytano z `origin/main` = `2a298b5` (PR #4), pliki `docs/audit/ROADMAP.md` i `docs/audit/ARCHITECTURE.md`. Bez pull/reset/clean/rebase/merge.
Ostatni commit CP3: `3ccd481`; CP2: `6c79ed2`; CP1: `7ccb040`.

| Checkpoint | Status |
|---|---|
| CP1 — fundament aplikacji | DONE |
| CP2 — prawdziwe uwierzytelnianie | DONE |
| CP3 — instalatory | KOD DONE; Debian 13/systemd PASS; Proxmox NIEZWERYFIKOWANY |
| CP4 — updater i rollback | NOT STARTED |
| CP5 — integracja | NOT STARTED |

## Raport odzyskiwania po restarcie LXC

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

## Niezweryfikowane i blokery

Brak testowego Proxmoxa. Sandbox nie ma systemd jako PID 1; test instalatora wykonywany wyłącznie w odizolowanej VM z systemd. Poprzednia sesja potwierdziła pierwszą instalację; odzyskana sesja potwierdziła końcowy artefakt na świeżej VM Debian 13/systemd. Przeglądarka/HTTPS pozostają do CP5. Nie ma obecnie blokera implementacji CP3. Sandboxing wymaga podniesienia uprawnień narzędzia dla zapisu `.git`, sieci oraz wiarygodnych testów z subprocessami/połączeniem PostgreSQL; te działania są objęte poleceniem użytkownika.

## Dokładny następny krok

CP4: rozszerzyć istniejący kontroler o update/rollback/status. Przypięty artefakt, kontrola zgodności historii migracji, backup przed migracją, trwały journal etapów, atomowy symlink i readiness; błędne wydanie odzyskuje wcześniejszy kod tylko jeśli rzeczywista DB jest zgodna. Brak automatycznego downgrade/restore DB. Testy awarii i integracja na tej samej izolowanej VM, kolejno; po wynikach commit/push CP4 oraz statusu. Następnie CP5: pełny cykl z kontem/sesją i przeglądarką. Proxmox pozostaje niezweryfikowany.

W nowej sesji najpierw ten plik, git status i commity; nie powtarzaj CP1/CP2/CP3. Nie merguj, nie uruchamiaj Codex Review ani rzeczywistego pct. Testy wykonywać wyłącznie w izolacji; nigdy instalator na roboczym LXC/hoście.
