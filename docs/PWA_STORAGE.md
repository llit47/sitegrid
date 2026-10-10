# PR15 — M09: instalowalna powłoka i fundament IndexedDB

SiteGrid działa w przeglądarce oraz jako PWA z ikoną produktu i trybem `standalone`. Produkcja wymaga HTTPS; localhost jest wyjątkiem developerskim. Manifest ma stabilne `id`, `start_url` i `scope` `/`, polską nazwę produktu, kolory oraz ikony PNG 192/512 (także maskable) i apple-touch-icon 180. Tryb standalone uwzględnia obszary bezpieczne ekranu. Ścieżka wdrożenia pozostaje korzeniem origin, jak w istniejącym nginx.

Android/desktop: instalacja przez menu przeglądarki; dodatkowy przycisk pojawia się, jeżeli przeglądarka udostępni `beforeinstallprompt`. iOS/iPadOS: Safari → Udostępnij → Do ekranu głównego → Dodaj. Instrukcje są dostępne niezależnie od programowego promptu. Odmowa lub brak instalacji nie blokują użytkowania w przeglądarce. Manifest/worker są generowane tylko w buildzie produkcyjnym; Vite dev działa online.

## Ściśle statyczny cache

`apps/web/build/pwa.ts` tworzy identyfikator SHA-256 z wersji wydania, kodu workera, ikony, HTML i wszystkich wygenerowanych zasobów JS/CSS. HTML wskazuje manifest i ikony `/pwa/<hash>/…`; kopia tego samego HTML pod `/pwa/<hash>/shell.html` jest bezpiecznym fallbackiem. Każdy plik ma własny digest SHA-256 w jawnym allowlist workera. Nie ma listy pobranej z API ani wildcard runtime caching.

Cache `sitegrid-shell-v1-<64-znakowy hash>` zawiera tylko tę listę. Worker podczas install pobiera pliki z `credentials: omit`, bez przekierowań, weryfikuje URL, typ odpowiedzi, brak `Set-Cookie`/`Vary: Cookie|Authorization` oraz bajty SHA-256. Odpowiedź prywatna, zastępczy HTML zamiast brakującego assetu, quota lub przerwany build powodują błąd instalacji i usunięcie częściowego cache. Działający poprzedni worker pozostaje aktywny. Zasoby builda mają immutable headers; `/`, `/sw.js` i strona zaproszenia mają `no-store`. Brakujące `/assets/` i `/pwa/` zwracają 404.

`/api` i **wszystkie `/api/…`** omijają worker, również przy nawigacji. Tak samo health, obcy origin, metody inne niż GET, Authorization, Range, zasoby spoza listy i zapytania do zasobów statycznych. Nie zapisujemy odpowiedzi nawigacji, cookies, sesji, tokenów, zaproszeń, profili, projektów, zadań ani autoryzowanych logo. Offline navigation fallback obsługuje wyłącznie aktualne trasy aplikacji `/` oraz `/invitations/accept` i zwraca statyczną powłokę aktywnego wydania. Fragment zaproszenia nigdy nie trafia do cache; jego istniejący przepływ online pozostaje bez zmian. Nie ma cache dla arbitralnych ścieżek.

Aktualizacja sprawdza worker przy rejestracji, powrocie do okna i odzyskaniu sieci (`updateViaCache: none`). **Nie używa `skipWaiting`.** Nowy worker przygotowuje osobny cache, a UI prosi o zamknięcie wszystkich kart/okien SiteGrid i ponowne otwarcie. Pozwala dokończyć bieżący formularz/komendę; nie wymusza reload ani replay. Przy activate usuwane są tylko stare nazwy pasujące dokładnie do własnego wzorca; cache innych aplikacji pozostają. Rollback serwera dostarcza poprzedni pełny build i przebiega tak samo jak aktualizacja PWA. Sama podmiana serwera nie wymusza wymiany otwartych klientów. Nie należy usuwać ręcznie cache aktywnego workera podczas użytkowania; usunięcie danych witryny wymaga ponownego przygotowania online.

## IndexedDB: schemat 2 (PR17 / M10)

`apps/web/src/storage/indexed-db.ts` zachowuje nazwy `sitegrid-project-<konto UUID>-<firma UUID>-<projekt UUID>` i owner metadata format 1. Jawny upgrade 1 → 2 dodaje store `confirmed` dla całego zweryfikowanego snapshotu. Nie kasuje innych stores; nowszy nieobsługiwany schemat i uszkodzone dane są błędami, bez resetu. Atomowe zastąpienie kończy się sukcesem wyłącznie po COMMIT; quota/abort/walidacja zachowują poprzedni zapis. Probe `sitegrid-idb-probe` pozostaje niesekretny i w schema 1.

M10 otwiera rzeczywiste partycje wybranego projektu. Osobna baza `sitegrid-offline-access` przechowuje UUID konta zweryfikowane online, generation i katalog dopuszczonych zakresów. Nie zapisujemy sekretów sesji ani treści API do Cache Storage, localStorage lub sessionStorage. Przed zmianą konta trwały, wyłącznie odmowny cookie blokuje offline także w razie błędu cleanup. Własność, schema 2, walidacja/hash, 24-godzinna polityka dostępu, logout/zmiana konta i procedury naprawcze: [kontrakt M10](PROJECT_SNAPSHOTS.md).

Brak IDB/cache nie blokuje zwykłej pracy online i nie daje gotowości offline. Usunięcie danych witryny wymaga ponownego przygotowania. Izolacja aplikacyjna nie chroni przed osobą z dostępem do odblokowanego profilu ani kodem z tego samego origin.

## Faktyczne zachowanie offline

Bootstrap strony przechwytuje token z `/invitations/accept#…` i synchronicznie usuwa fragment przed renderowaniem, również przy uruchomieniu offline. Parametry URL i stan historii pozostają zachowane. Token żyje wyłącznie w pamięci bieżącej strony i jest przekazywany ponownie po odmontowaniu/montowaniu aplikacji przy offline/online; akceptacja nadal wymaga połączenia i dotychczasowej kontroli sesji/CSRF. Pełny reload lub zamknięcie strony usuwa token z pamięci — aby wrócić do zaproszenia, trzeba otworzyć oryginalny link. Token nie trafia do trwałej pamięci, cache ani logów.

UI rozróżnia tryb online, przygotowanie/dostępność powłoki, kompletnie przygotowany projekt tylko do odczytu, brak ważnych danych offline, błąd IDB i aktualizację. `navigator.onLine` jest wskazówką łączności, nie dowodem zdrowia API; istniejące błędy serwera i retry pozostają widoczne. M10 pozwala jawnie otworzyć kontrolowany odczyt lokalny również przy niedostępnym API, gdy navigator.onLine nadal zgłasza true. Przy zdarzeniu offline cały widok sesji, firm, logo i zadań jest odmontowywany. Offline restart może wyświetlić tylko wcześniej przygotowany, zweryfikowany zakres M10 z nadal ważną autoryzacją lokalną; bez niego wyświetla powłokę i komunikat o wymaganej sieci. Powrót online montuje świeżą aplikację, pobiera sesję i aktualne uprawnienia, bez automatycznego odtwarzania mutacji. Restore z BFCache również odświeża kontekst. Login/logout wysyłają do innych kart wyłącznie sygnał invalidacji przez BroadcastChannel, bez danych konta/sesji.

Utrata potwierdzenia M08 nadal wymaga istniejącego retry z tym samym ID, dopóki komponent pozostaje zamontowany. Zamknięcie, odmontowanie przy utracie sieci lub zmiana kontekstu usuwa request z pamięci; trwałość i odzyskiwanie będą dopiero w M11. „Gotowy offline” w M10 wymaga kompletnego COMMIT snapshotu i dostępnej powłoki. Nie pokazujemy „zmiany zsynchronizowane”; nie ma zapisów offline. Bez wcześniejszego udanego install/cache albo po usunięciu pamięci offline launch może być niemożliwy. Instalacja PWA i offline shell nie oznaczają spełnienia pełnej bramki MVP.

**M09C wdrożono w PR16; M10 odczyt snapshotów w PR17. Następny oddzielny etap: M11 (trwała kolejka).** M10 nie implementuje zapisów offline, synchronizacji, konfliktów ani godzin i nie kończy MVP.

## Akceptacja manualna Android/iOS

Wykonać na fizycznych urządzeniach, z produkcyjnym HTTPS; zapisać wersję systemu/przeglądarki i wynik:

1. Android Chrome: menu/przycisk instalacji, ikona SiteGrid, standalone, poprawne pola/przyciski i brak przewijania poziomego. Powtórzyć użytkowanie bez instalacji.
2. iPhone/iPad Safari: Udostępnij → Do ekranu głównego, ikona produktu/nazwa, standalone i safe areas. Zweryfikować instrukcję bez beforeinstallprompt.
3. Poczekać na „Powłoka aplikacji gotowa…”, zalogować się, otworzyć projekt, odciąć sieć. Bez przygotowania nie mogą pojawić się dane biznesowe. Przygotować wybrany projekt M10 i powtórzyć: tylko jego uprawniony zakres, wyłącznie do odczytu, w okresie 24 h. Zamknąć i ponownie otworzyć PWA offline; sprawdzić expiry i brak innych projektów. Szczegóły odbioru w kontrakcie M10.
4. Przywrócić sieć: świeża sesja/kontekst, bez replay komend. Wylogować się, zalogować na inne konto i sprawdzić brak danych poprzedniej osoby; powtórzyć dla drugiej karty.
5. Dostarczyć nowe kompletne wydanie testowe: komunikat aktualizacji, stara karta nadal działa; zamknąć wszystkie okna i uruchomić nową wersję. Sprawdzić offline restart i cache; powtórzyć zgodny rollback.
6. Usunąć dane witryny lub zablokować pamięć: brak fałszywego potwierdzenia gotowości offline; online nadal działa. Powtórzyć bez wcześniejszego przygotowania urządzenia.

Automaty Chromium desktop/mobile nie zastępują tego odbioru. Fizyczny Android/iOS i świeży Debian 13/systemd nie są zweryfikowane w PR15.

## Wynik walidacji lokalnej 2026-10-10

Node 24.21.0, PostgreSQL 17.11, oddzielny runtime `sitegrid` bez superuser/BYPASSRLS/CREATEROLE. `npm run check`: **146/146**, zero błędów/pominięć. Playwright 1.64.0/Chromium: wszystkie cztery zestawy (`pwa`, `organization-branding`, `projects`, `task-progress`) przeszły desktop/mobile, bez błędów runtime/CSP. Starsze zestawy online blokują worker w kontekście Playwright, aby deterministycznie przechwytywać i opóźniać żądania HTTP ([ograniczenie routingu Playwright](https://playwright.dev/docs/network#missing-network-events-and-service-workers)); dedykowany zestaw PWA używa rzeczywistego workera. PWA obejmuje też dwie karty przy logout/login, oczekiwanie aktualizacji na zamknięcie wszystkich klientów oraz zaproszenia otwierane offline i przejścia offline/online (nowe i istniejące konto, fragment usunięty przed pierwszym renderowaniem, zachowane parametry URL/stan historii, brak tokenu w trwałej pamięci). IDB sprawdzono w rzeczywistej przeglądarce; błędy quota/abort są deterministycznie wstrzykiwane, bez zapełniania dysku hosta. Rzeczywista paczka Linux x64 i zestaw Python: **54/54**, zero pominięć; asset digests/manifest/ikony, installer, podpisany kanał, update i rollback. Walidacje shell/Python/JS oraz `git diff --check` przeszły. Nie opublikowano wydania, tagu ani nie wdrożono aplikacji.
