# SiteGrid M01 — status PR #5

Branch: `feat/m01-working-foundation`. Repozytorium `llit47/sitegrid` i planowane Releases są **publiczne**. Instalacja wyłącznie w gotowym Debianie 13/systemd, również LXC. Pierwszego Release nie opublikowano.

## Zachowana implementacja i odzyskiwanie

CP1 React/Fastify/PostgreSQL i CP2 logowanie/sesje są ukończone. CP3/CP4 zachowują instalator i lifecycle: P1 `071374e` utrwala rezerwację przed nginx; P2 `f707e35` publikuje kompletny katalog ze znacznikiem atomowo przez renameat2 NOREPLACE/fsync, bez przejmowania obcych katalogów. Nie zaczynano od nowa i nie utracono zmian. Historyczna walidacja CP5 `17e9d0c`: testy Node/Python, Debian/systemd, przeglądarka/HTTPS, update/rollback/backup/restore. Szczegółowy audyt odzyskiwania zachowany w historii (`a597b9d`, `f707e35`) i ignorowanych kopiach `.recovery/`.

## Checkpoint A — podpisany kanał i one-line bootstrap

Implementacja `cc265a9` została wypchnięta; [CI PASS](https://github.com/llit47/sitegrid/actions/runs/37965994512) obejmuje 15 testów Node, typecheck/build/pakiet i wcześniejsze 49 testów Python.

- Publiczny GitHub przez HTTPS z kontrolą przekierowań/limitów; manifest Ed25519, przypięty klucz, repo/tag/architektura/nazwy/SHA-256/daty. API latest jest niezaufanym lokalizatorem; brak Release/zły podpis zatrzymuje operację.
- Samodzielny deterministyczny bootstrap z przypiętą wersją/kluczem i wygenerowana pełna komenda z SHA-256 sprawdzaną **przed wykonaniem** bootstrapu. Bez kopiowania ops/archiwum, bez kodu z main i bez poświadczeń klienta. Pytania origin/potwierdzenie, PostgreSQL 17/nginx/Node/SiteGrid/systemd, readiness.
- `sitegrid update` bez flag wymaga TAK przed pobraniem pakietu/wdrożeniem. Zachowuje blokadę, backup, migracje, readiness i rollback oraz manualny komplet flag. Bez aktualizacji w tle. Kotwica `/usr/local/lib/sitegrid/release-public.pem` pozostaje od instalacji; kanał nie podmienia jej kluczem z nowego wydania. Monotoniczny stan wersji przetrwa rollback i retry starszego bootstrapu.

## Checkpoint B — klucz i przygotowanie wydania

Po zgodzie użytkownika wygenerowano nowy Ed25519. Publiczny klucz: `ops/release-public.pem`; SHA-256 pliku PEM `3a6e17d95f6db366e851e530f1029669cd72cba3cf7e5baea024af6bec4c7094`. Prywatny: `/home/codex/.local/share/sitegrid-release-signing/ed25519.pem`, prawa 0600/katalog 0700; nigdy nie kopiowany do repo ani logów. Kopia poza LXC i sekret GitHub **nie są jeszcze skonfigurowane**.

Workflow tagu vX.Y.Z wymaga historii main, zgodności package.json/release.json/tagu i sukcesu reusable CI. Podpisuje ten sam przetestowany artefakt, sprawdza również jego klucz i tworzy **wyłącznie Draft**. Środowisko `release-signing` wymaga konfiguracji operatora; publikacja dopiero po osobnym zatwierdzeniu użytkownika. Workflow publikacyjny nie był jeszcze uruchomiony. Procedura: RELEASES.md. Obecny build wspiera Linux x64; arm64 wymaga osobnej przetestowanej paczki.

## Checkpoint C — końcowe testy i konflikt

- **52/52 Python PASS**, bez pominięć: 13 instalator, 10 lifecycle, 10 pakiet, 19 kanał. Rzeczywiste pliki/podpisy/fsync/rename, granice APT/systemd/DB mockowane. Odmowa hosta Proxmoxa przed blokadą/APT (również runner i samodzielny bootstrap), dokładne regresje przerwania po nginx (P1), po mkdir przed znacznikiem (P2), obce katalogi/symlinki/DB/konfiguracja, brak Release, zły podpis/SHA, wygasły/cofnięty manifest, potwierdzenie, manualny CLI i rollback.
- Końcowy pakiet z przypiętym kluczem: build/runtime/native PASS; typecheck, py_compile, bash -n, deterministyczny bootstrap/wykonanie komendy z kontrolą SHA i git diff --check PASS. Lokalny podpisujący CLI sprawdzany tylko kluczem fixture; nie podpisano oficjalnego wydania.
- **Rzeczywisty świeży Debian 13/systemd:** pojedyncza wygenerowana komenda → instalacja → readiness 0.1.0 → ponowienie → administrator CLI bez echa hasła → logowanie HTTPS → update 0.1.1 po TAK i backupie → readiness → rollback 0.1.0 → logowanie. Konfiguracja i klucz TLS zachowane (porównanie hashy), konto zachowane. HTTP 404/brak Release, uszkodzony podpis i uszkodzony pakiet odrzucone przed zmianą deploymentu; cofnięty podpisany kanał po rollbacku również odrzucony.
- Integracja używa lokalnych podpisanych fixture, lokalnego serwera HTTPS/testowej CA oraz mapowania hostów GitHub. Do VM przed instalacją nie kopiowano ops ani archiwum. Nie dowodzi jeszcze dostępności oficjalnych assetów. Dysk nowej VM zachowany, VM wyłączona po testach; stare VM/dane nietknięte. LXC: 4 GiB RAM/~2.3 GiB wolnego dysku na początku. Najwyżej jedna VM, buildy/testy sekwencyjne.

Po wyraźnej zgodzie użytkownika włączono origin/main `2a298b5` lokalnie do brancha PR; konflikt ograniczał się do ROADMAP.md/ARCHITECTURE.md. Zachowano późniejszą decyzję Debian-only i publiczny kanał oraz pozostałe wymagania main. Kod checkpointu `71ab1dd` nie zmienił się przy rozwiązywaniu konfliktu. Końcowa kontrola dodała jawną odmowę hosta Proxmoxa (/etc/pve lub pveversion) przed APT w komendzie i bootstrapie oraz przed blokadą w instalatorze; regresje przeszły bez operacji na hoście. Żadnego reset/clean/rebase/force push ani merge PR do main.

## Dokładny następny krok / pierwsze wydanie

Zmiany i rozwiązany konflikt wypchnięto do PR #5, opis uaktualniono; PR pozostaje Draft i GitHub potwierdził brak konfliktu. [Końcowe CI kodu a7c9b18 PASS](https://github.com/llit47/sitegrid/actions/runs/37970442234): 15/15 Node oraz 51/51 Python, bez pominięć, typecheck/build/pakiet i kontrole skryptów. Dodatkowa odmowa hosta ma końcowe lokalne 52/52 Python; CI po ostatnim push jest sprawdzane przed przekazaniem PR do oceny. Dokładny następny krok: czekać na ocenę użytkownika; nie integrować PR ani nie publikować Release bez jego decyzji. Przed pierwszym Release operator musi wykonać kopię klucza poza LXC, skonfigurować chronione środowisko signing/sekret, zaakceptować i zintegrować PR, wskazać przetestowany commit main/tag, uruchomić pipeline Draft i sprawdzić assety/komendę. Pierwsza publikacja wymaga odrębnego zatwierdzenia; dopiero wtedy README otrzyma konkretną działającą komendę. Nie utworzono tagu/Release, nie scalono PR i nie uruchomiono Codex Review.
