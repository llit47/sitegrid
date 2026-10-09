# SiteGrid M01 — status PR #5

Branch: `feat/m01-working-foundation`. Repozytorium `llit47/sitegrid` i planowane Releases są **publiczne**. Instalacja wyłącznie w gotowym Debianie 13/systemd, również LXC; bez tworzenia maszyn i operacji na hoście wirtualizacji. Pierwszego Release nie opublikowano.

## Zachowana implementacja

CP1 React/Fastify/PostgreSQL i CP2 prawdziwe logowanie/sesje są ukończone. Istniejący instalator i lifecycle zachowane; P1 `071374e` utrwala rezerwację przed nginx, P2 `f707e35` publikuje katalog ze znacznikiem atomowo i nie zastępuje obcych katalogów. Historyczna walidacja CP5 `17e9d0c`: 15 testów Node, wcześniejsze testy Python i Debian/systemd, HTTPS/logowanie w przeglądarce, update/rollback/backup/restore. Te wyniki nie zastępują nowej walidacji publicznego bootstrapu.

## Checkpoint A — podpisany kanał i bootstrap

- `ops/channel.py`: publiczny GitHub, HTTPS i kontrolowane przekierowania/limity; Ed25519 z lokalnie przypiętym kluczem; repo/tag/architektura/nazwy/SHA-256/daty; ochrona przed cofnięciem zaufanej wersji po rollbacku. API latest jest tylko niezaufanym lokalizatorem. Brak Release i złe podpisy zatrzymują operację.
- `scripts/build-bootstrap.py`: deterministyczny samodzielny bootstrap z przypiętą wersją/kluczem oraz pełna komenda z przypiętą SHA-256, sprawdzana przed wykonaniem. Bootstrap zawiera istniejący instalator, pobiera zweryfikowaną paczkę i instaluje zależności; bez kopiowania ops/archiwum. Pyta o origin/potwierdzenie i kończy readiness.
- `sitegrid update` bez flag pokazuje wersje i wymaga TAK przed pobraniem pakietu/wdrożeniem; zachowuje dotychczasową blokadę, backup, kontrolę migracji/readiness/rollback. Manualny komplet flag zachowany; częściowy zestaw odrzucany. Bez aktualizacji w tle.
- **49/49 testów Python PASS**, bez pominięć, z aktualnie zbudowanym pakietem fixture 0.1.0; 17 nowych testów podpisów/transportu/CLI/instalacji i retry P1/P2/potwierdzenia/update/rollback. Podpisy i pliki rzeczywiste, granice APT/systemd/DB mockowane. Build paczki/runtime PASS; bootstrap powtarzalny; py_compile/bash -n/git diff --check PASS. Testowy klucz prywatny i artefakty wyłącznie w `/tmp/sitegrid-public-lab`, nie w git.

## Checkpoint B — przygotowanie wydania

Workflow tagu `vX.Y.Z` wymaga historii main i sukcesu reusable CI, następnie podpisuje ten sam przetestowany artefakt i tworzy **wyłącznie Draft**. Środowisko `release-signing` i dopasowany sekret klucza; publikacja przez operatora po odrębnym zatwierdzeniu. Procedura: RELEASES.md. Branch CI może użyć efemerycznego klucza fixture, tag nie może.

**Klucz wydawcy czeka na decyzję:** wygenerować nowy poza repozytorium czy przypiąć dostarczoną publiczną część istniejącego klucza. Nie dodano klucza fixture jako produkcyjnego. Do czasu wyboru produkcyjny bootstrap/Release nie jest gotowy do publikacji.

## Checkpoint C — integracja i konflikt

Test świeżego Debiana/systemd z lokalnymi podpisanymi fixture planowany sekwencyjnie, bez zmiany/usuwania zachowanych VM. LXC: 4 GiB RAM, ~3.7 GiB dostępne, dysk ~2.3 GiB; najwyżej jedna testowa VM i brak równoległego builda.

main `2a298b5` zawiera starszy zakres instalacji; branch zachowuje późniejszą decyzję Debian-only. **Automatyczna kontrola odrzuciła lokalne git merge origin/main z powodu zakazu NIE MERGUJ; nic nie wykonano.** Pytanie o zgodę na włączenie main wyłącznie do brancha PR jest w toku. Konflikt PR nie jest jeszcze rozwiązany; nie wolno obchodzić odmowy.

## Następny krok / pierwsze wydanie

Dokończyć sekwencyjny test czystego Debiana z fixture, po odpowiedziach przypiąć klucz i rozwiązać konflikt w dwóch dokumentach. Ustawić chronione środowisko signing/sekret i kopię klucza poza LXC, sprawdzić CI końcowego commita, uzyskać ocenę użytkownika. Dopiero po zatwierdzeniu: tag sprawdzonego commita main, Draft i zatwierdzona publikacja pierwszego Release z pełną komendą instalacji. Nie utworzono tagu/Release, nie scalono PR i nie uruchomiono Codex Review.

Wcześniejszy szczegółowy audyt odzyskiwania jest zachowany w historii (`a597b9d`, `f707e35`) oraz ignorowanych kopiach `.recovery/`; nie usuwano danych, sekretów ani testowych dysków.
