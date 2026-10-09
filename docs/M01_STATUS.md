# M01 — checkpointy i wznowienie

Branch: `feat/m01-working-foundation`, baza `origin/main` = `59b2fb2`.
PR #4 `docs/first-milestone-installer-auth` odczytany; wymagania uwzględnione. Użytkownik poinformował o merge `2a298b5`; po zapisaniu CP2 odczytać origin/main, bez merge/rebase/reset.
Ostatni commit implementacyjny: `6c79ed2` (CP2); CP1: `7ccb040`.

| Checkpoint | Status |
|---|---|
| CP1 — fundament aplikacji | DONE |
| CP2 — prawdziwe uwierzytelnianie | DONE |
| CP3 — instalatory | NOT STARTED |
| CP4 — updater i rollback | NOT STARTED |
| CP5 — integracja | NOT STARTED |

## Co rzeczywiście działa

React/TypeScript z responsywnym logowaniem i panelem administratora, Fastify/TypeScript, produkcyjny build i serwowanie frontendu. PostgreSQL 17+; transakcyjne migracje z blokadą i weryfikacją zapisanych sum SHA-256. Liveness i readiness; oddzielna konfiguracja development/production, wymagane HTTPS origin w produkcji.

Globalne konta i credentials, Argon2id (64 MiB/3/1), sesje PostgreSQL z hashem identyfikatora i rotacją przy logowaniu. CSRF + Origin, trwałe atomowe limity IP/konta, bezpieczne komunikaty, wylogowanie z unieważnieniem sesji. Cookie HttpOnly/SameSite Strict; Secure i __Host w produkcji. Lokalny interaktywny jednorazowy bootstrap (również ochrona wyścigu), niewidoczne hasło, brak rejestracji i haseł domyślnych. Osobne uprawnienie platformowe przygotowuje model pod M02–M04.

## Testy i wyniki

- Debian 13 w środowisku roboczym, Node 24.21.0, odizolowany PostgreSQL 17.11 pobrany i rozpakowany w `/tmp/sitegrid-pg`; bez zmian usług systemowych.
- `TEST_DATABASE_URL=postgresql://codex@127.0.0.1:55432/sitegrid_test npm run check`: typy, oba buildy i **3/3 testy PASS**, zero pominiętych. Konfiguracja produkcyjna; niedostępna baza; ponowienie migracji; odmowa readiness i migracji przy naruszonej historii.
- `npm audit`: **0 podatności** po aktualizacji `@fastify/static` do 10.1.5.
- CI CP1: **SUCCESS**, run `37935068323`.
- CP2: typy i build obu aplikacji PASS; testy z prawdziwym PostgreSQL **15/15 PASS**, zero pominiętych. Udane logowanie, błędne hasło/nieznany email, 401 bez sesji, CSRF/obcy Origin, rotacja, cookie HTTPS, logout, równoległy bootstrap i próby logowania, ponowne utworzenie serwera/puli i dwa rzeczywiste starty skompilowanego procesu API z zachowaną sesją.
- Rzeczywiste CLI przez PTY: pierwsze utworzenie konta PASS, ponowienie odrzucone, hasło niewyświetlane; uruchomienie bez lokalnego terminala odrzucone.
- CP2 `npm audit --omit=dev`: **0 podatności**. Zdalne CI CP2 sprawdzić po push.

## Niezweryfikowane i blokery

Brak Proxmoxa i systemd jako PID 1. Instalacja czystego Debiana/systemd i hostowy instalator Proxmoxa nie zostały uruchomione. Restart rzeczywistego procesu API zweryfikowany; restart jednostki systemd i przeglądarka/HTTPS pozostają do CP5. Nie ma obecnie blokera implementacji CP3. Sandboxing wymaga podniesienia uprawnień narzędzia dla zapisu `.git`, sieci oraz wiarygodnych testów z subprocessami/połączeniem PostgreSQL; te działania są objęte poleceniem użytkownika.

## Dokładny następny krok

Po wypchnięciu tego statusu: `git fetch origin main`; odczytać tylko sekcje M01/instalacji w `origin/main:docs/audit/ROADMAP.md` i `origin/main:docs/audit/ARCHITECTURE.md`. Bez merge/rebase/reset. Następnie CP3: weryfikowalne, przypięte artefakty dostarczane również offline dla prywatnego repo, runtime Node 24, systemd/PG/osobne role, wydania/config/data oraz instalatory Debian 13 i nowy nieuprzywilejowany LXC. Rzeczywistego Proxmoxa nie uruchamiać bez zgody. Po CP3 osobno commit/push implementacji, następnie status z jej SHA i commit/push statusu.

W nowej sesji najpierw przeczytaj ten plik, `git status --short --branch` i ostatnie commity. Nie powtarzaj CP1/CP2. Nie merguj, nie uruchamiaj Codex Review ani rzeczywistego `pct`.
