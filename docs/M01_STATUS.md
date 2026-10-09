# M01 — checkpointy i wznowienie

Branch: `feat/m01-working-foundation`, baza `origin/main` = `59b2fb2`.
PR #4 `docs/first-milestone-installer-auth` odczytany; wymagania uwzględnione, bez merge.
Ostatni commit implementacyjny: `7ccb040` (CP1).

| Checkpoint | Status |
|---|---|
| CP1 — fundament aplikacji | DONE |
| CP2 — prawdziwe uwierzytelnianie | NOT STARTED |
| CP3 — instalatory | NOT STARTED |
| CP4 — updater i rollback | NOT STARTED |
| CP5 — integracja | NOT STARTED |

## Co rzeczywiście działa

React/TypeScript z responsywną stroną startową, Fastify/TypeScript, produkcyjny build i serwowanie frontendu. PostgreSQL 17+; transakcyjne migracje z blokadą i weryfikacją zapisanych sum SHA-256. Liveness i readiness (baza + zgodność migracji); oddzielna konfiguracja development/production, wymagane HTTPS origin w produkcji. CI z prawdziwym PostgreSQL na runnerze. Brak logowania na tym checkpointcie.

## Testy i wyniki

- Debian 13 w środowisku roboczym, Node 24.21.0, odizolowany PostgreSQL 17.11 pobrany i rozpakowany w `/tmp/sitegrid-pg`; bez zmian usług systemowych.
- `TEST_DATABASE_URL=postgresql://codex@127.0.0.1:55432/sitegrid_test npm run check`: typy, oba buildy i **3/3 testy PASS**, zero pominiętych. Konfiguracja produkcyjna; niedostępna baza; ponowienie migracji; odmowa readiness i migracji przy naruszonej historii.
- `npm audit`: **0 podatności** po aktualizacji `@fastify/static` do 10.1.5.
- Wynik zdalnego CI należy sprawdzić przy wznowieniu; workflow został wypchnięty wraz z CP1.

## Niezweryfikowane i blokery

Brak Proxmoxa i systemd jako PID 1. Instalacja czystego Debiana/systemd i hostowy instalator Proxmoxa nie zostały uruchomione. Nie ma obecnie blokera CP2. Sandboxing wymaga podniesienia uprawnień narzędzia dla zapisu `.git`, sieci oraz wiarygodnych testów z subprocessami/połączeniem PostgreSQL; te działania są objęte poleceniem użytkownika.

## Dokładny następny krok

Po wypchnięciu tego statusu rozpocząć CP2: tabele globalnej tożsamości, credentials, platform_admins i trwałe sessions; Argon2id, lokalny jednorazowy bootstrap, CSRF/limity, panel/logowanie/wylogowanie i test restartu. Po CP2 osobno commit/push implementacji, następnie status z jej SHA i commit/push statusu. Nie rozpoczynać CP3 przed tym zapisem.

W nowej sesji najpierw przeczytaj ten plik, `git status --short --branch` i ostatnie commity. Nie powtarzaj CP1. Nie merguj, nie uruchamiaj Codex Review ani rzeczywistego `pct`.
