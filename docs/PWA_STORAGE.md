# PR15 — M09: instalowalna powłoka i fundament IndexedDB

SiteGrid działa w przeglądarce oraz jako PWA z ikoną produktu i trybem `standalone`. Produkcja wymaga HTTPS; localhost jest wyjątkiem developerskim. Manifest ma stabilne `id`, `start_url` i `scope` `/`, polską nazwę produktu, kolory oraz ikony PNG 192/512 (także maskable) i apple-touch-icon 180. Tryb standalone uwzględnia obszary bezpieczne ekranu. Ścieżka wdrożenia pozostaje korzeniem origin, jak w istniejącym nginx.

Android/desktop: instalacja przez menu przeglądarki; dodatkowy przycisk pojawia się, jeżeli przeglądarka udostępni `beforeinstallprompt`. iOS/iPadOS: Safari → Udostępnij → Do ekranu głównego → Dodaj. Instrukcje są dostępne niezależnie od programowego promptu. Odmowa lub brak instalacji nie blokują użytkowania w przeglądarce. Manifest/worker są generowane tylko w buildzie produkcyjnym; Vite dev działa online.

## Ściśle statyczny cache

`apps/web/build/pwa.ts` tworzy identyfikator SHA-256 z wersji wydania, kodu workera, ikony, HTML i wszystkich wygenerowanych zasobów JS/CSS. HTML wskazuje manifest i ikony `/pwa/<hash>/…`; kopia tego samego HTML pod `/pwa/<hash>/shell.html` jest bezpiecznym fallbackiem. Każdy plik ma własny digest SHA-256 w jawnym allowlist workera. Nie ma listy pobranej z API ani wildcard runtime caching.

Cache `sitegrid-shell-v1-<64-znakowy hash>` zawiera tylko tę listę. Worker podczas install pobiera pliki z `credentials: omit`, bez przekierowań, weryfikuje URL, typ odpowiedzi, brak `Set-Cookie`/`Vary: Cookie|Authorization` oraz bajty SHA-256. Odpowiedź prywatna, zastępczy HTML zamiast brakującego assetu, quota lub przerwany build powodują błąd instalacji i usunięcie częściowego cache. Działający poprzedni worker pozostaje aktywny. Zasoby builda mają immutable headers; `/`, `/sw.js` i strona zaproszenia mają `no-store`. Brakujące `/assets/` i `/pwa/` zwracają 404.

`/api` i **wszystkie `/api/…`** omijają worker, również przy nawigacji. Tak samo health, obcy origin, metody inne niż GET, Authorization, Range, zasoby spoza listy i zapytania do zasobów statycznych. Nie zapisujemy odpowiedzi nawigacji, cookies, sesji, tokenów, zaproszeń, profili, projektów, zadań ani autoryzowanych logo. Offline navigation fallback obsługuje wyłącznie aktualne trasy aplikacji `/` oraz `/invitations/accept` i zwraca statyczną powłokę aktywnego wydania. Fragment zaproszenia nigdy nie trafia do cache; jego istniejący przepływ online pozostaje bez zmian. Nie ma cache dla arbitralnych ścieżek.

Aktualizacja sprawdza worker przy rejestracji, powrocie do okna i odzyskaniu sieci (`updateViaCache: none`). **Nie używa `skipWaiting`.** Nowy worker przygotowuje osobny cache, a UI prosi o zamknięcie wszystkich kart/okien SiteGrid i ponowne otwarcie. Pozwala dokończyć bieżący formularz/komendę; nie wymusza reload ani replay. Przy activate usuwane są tylko stare nazwy pasujące dokładnie do własnego wzorca; cache innych aplikacji pozostają. Rollback serwera dostarcza poprzedni pełny build i przebiega tak samo jak aktualizacja PWA. Sama podmiana serwera nie wymusza wymiany otwartych klientów. Nie należy usuwać ręcznie cache aktywnego workera podczas użytkowania; usunięcie danych witryny wymaga ponownego przygotowania online.

## IndexedDB: schemat 1

`apps/web/src/storage/indexed-db.ts` udostępnia `openProjectStorage(scope)`, `projectDatabaseName(scope)`, `checkLocalStorage()` oraz `LocalStorageError` z kodami unavailable/blocked/quota/aborted/invalid/failed. Bez zależności i frameworku stanu.

- Własność bazy: origin + konto UUID + organizacja UUID + projekt UUID. Nazwa `sitegrid-project-<account UUID>-<organization UUID>-<project UUID>`; UUID są walidowane i normalizowane do małych liter. Wersja schematu jest argumentem `indexedDB.open`, nie częścią nazwy, co umożliwia przyszły upgrade tej samej partycji.
- Jedyny store `metadata`, out-of-line keys bez autoIncrement/indeksów. Jedyny trwały rekord `owner`: `{format: 1, accountId, organizationId, projectId}`. Odczyt sprawdza dokładny format i właściciela; uszkodzone, nieznane lub nowsze dane dają błąd, bez resetu bazy.
- Kontrolowany upgrade **0 → 1** tworzy store i metadane w transakcji versionchange. Nie ma migracji do wymyślonych przyszłych wersji. Każda przyszła wersja wymaga jawnej migracji i testów zachowania danych; rollback nie może otwierać nowszego schematu.
- Operacje inicjalizacji/weryfikacji kończą się sukcesem dopiero po COMMIT transakcji. Abort, wyjątek synchronizacyjny, quota, SecurityError, blokada i niezgodna struktura są błędami. Zablokowany/powolny open odrzuca po maksymalnie 5 s; spóźniony open jest zamykany, a jego upgrade przerywany. `versionchange` zamyka nasze połączenia, aby nie blokowały innych kart.
- `verify()` ponownie sprawdza właściciela. `close()` zwalnia uchwyt; późniejsza operacja nie jest sukcesem. Przyszły użytkownik interfejsu musi zamknąć i odrzucić uchwyt przy **każdej zmianie konta/firmy/projektu i wylogowaniu**, a nowy zakres wyprowadzić z aktualnie autoryzowanej odpowiedzi serwera. Nazwa ani metadane nie zastępują autoryzacji API.

M09 nie otwiera partycji rzeczywistych użytkowników z UI. Jedynie `sitegrid-idb-probe`, również schema 1/store metadata, sprawdza zapis i usunięcie stałego niesekretnego boolean `probe` w jednej transakcji. Po COMMIT store pozostaje pusty. Nie zapisujemy snapshotów, kolejki, uprawnień, adresów email ani sekretów uwierzytelniania. Baza probe nie ma właściciela użytkownika i nie jest katalogiem partycji. Przyszłe magazyny biznesowe należy dodać dopiero w M10–M12; nie udostępniamy dowolnego zapisu payloadów w M09.

Brak IDB/cache lub ich usunięcie przez system nie blokuje funkcji online. UI pokazuje błąd pamięci lokalnej bez obietnicy trwałości. Nie żądamy persistent storage i nie kasujemy baz innych aplikacji. M09 nie wymaga czyszczenia danych biznesowych przy wylogowaniu, ponieważ niczego takiego nie przechowuje; polityka retencji przyszłych snapshotów/kolejki należy do M10–M12. Izolacja aplikacyjna nie chroni przed osobą z dostępem do profilu przeglądarki/operatora urządzenia ani przed kodem wykonanym z tego samego origin.

## Faktyczne zachowanie offline

UI rozróżnia tryb online, przygotowanie/dostępność powłoki, brak danych projektów offline, błąd IDB i aktualizację. `navigator.onLine` jest wskazówką łączności, nie dowodem zdrowia API; istniejące błędy serwera i retry pozostają widoczne. Przy zdarzeniu offline cały widok sesji, firm, logo i zadań jest odmontowywany. Offline restart wyświetla wyłącznie powłokę i komunikat o wymaganej sieci. Powrót online montuje świeżą aplikację, pobiera sesję i aktualne uprawnienia, bez automatycznego odtwarzania mutacji. Restore z BFCache również odświeża kontekst. Login/logout wysyłają do innych kart wyłącznie sygnał invalidacji przez BroadcastChannel, bez danych konta/sesji.

Utrata potwierdzenia M08 nadal wymaga istniejącego retry z tym samym ID, dopóki komponent pozostaje zamontowany. Zamknięcie, odmontowanie przy utracie sieci lub zmiana kontekstu usuwa request z pamięci; trwałość i odzyskiwanie będą dopiero w M11. Nie pokazujemy „projekty dostępne offline” ani „zmiany zsynchronizowane”. Bez wcześniejszego udanego install/cache albo po usunięciu pamięci offline launch może być niemożliwy. Instalacja PWA i offline shell nie oznaczają spełnienia pełnej bramki MVP.

**Następny oddzielny etap: M09C (kontrahenci), przed M10.** M09 nie implementuje kontrahentów, snapshotów, kolejki, synchronizacji, konfliktów ani godzin.

## Akceptacja manualna Android/iOS

Wykonać na fizycznych urządzeniach, z produkcyjnym HTTPS; zapisać wersję systemu/przeglądarki i wynik:

1. Android Chrome: menu/przycisk instalacji, ikona SiteGrid, standalone, poprawne pola/przyciski i brak przewijania poziomego. Powtórzyć użytkowanie bez instalacji.
2. iPhone/iPad Safari: Udostępnij → Do ekranu głównego, ikona produktu/nazwa, standalone i safe areas. Zweryfikować instrukcję bez beforeinstallprompt.
3. Poczekać na „Powłoka aplikacji gotowa…”, zalogować się, otworzyć projekt, odciąć sieć. Żadne wcześniejsze dane firmy/zadania/konta nie mogą pozostać widoczne. Zamknąć i ponownie otworzyć PWA offline: tylko powłoka i informacja o braku danych.
4. Przywrócić sieć: świeża sesja/kontekst, bez replay komend. Wylogować się, zalogować na inne konto i sprawdzić brak danych poprzedniej osoby; powtórzyć dla drugiej karty.
5. Dostarczyć nowe kompletne wydanie testowe: komunikat aktualizacji, stara karta nadal działa; zamknąć wszystkie okna i uruchomić nową wersję. Sprawdzić offline restart i cache; powtórzyć zgodny rollback.
6. Usunąć dane witryny lub zablokować pamięć: brak fałszywego potwierdzenia gotowości offline; online nadal działa. Powtórzyć bez wcześniejszego przygotowania urządzenia.

Automaty Chromium desktop/mobile nie zastępują tego odbioru. Fizyczny Android/iOS i świeży Debian 13/systemd nie są zweryfikowane w PR15.

## Wynik walidacji lokalnej 2026-10-10

Node 24.21.0, PostgreSQL 17.11, oddzielny runtime `sitegrid` bez superuser/BYPASSRLS/CREATEROLE. `npm run check`: **144/144**, zero błędów/pominięć. Playwright 1.64.0/Chromium: wszystkie cztery zestawy (`pwa`, `organization-branding`, `projects`, `task-progress`) przeszły desktop/mobile, bez błędów runtime/CSP. PWA obejmuje też dwie karty przy logout/login i oczekiwanie aktualizacji na zamknięcie wszystkich klientów. IDB sprawdzono w rzeczywistej przeglądarce; błędy quota/abort są deterministycznie wstrzykiwane, bez zapełniania dysku hosta. Rzeczywista paczka Linux x64 i zestaw Python: **54/54**, zero pominięć; asset digests/manifest/ikony, installer, podpisany kanał, update i rollback. Walidacje shell/Python/JS oraz `git diff --check` przeszły. Nie opublikowano wydania, tagu ani nie wdrożono aplikacji.
