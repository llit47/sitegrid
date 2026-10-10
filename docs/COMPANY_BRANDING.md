# PR11 — branding i ustawienia firmy (M06)

Administrator firmy zmienia nazwę, kolor firmowy i logo wyłącznie swojej aktywnej firmy. Każdy aktywny członek (również bez roli) może odczytać branding. Rola platformowa nie daje dostępu. Uprawnienia wynikają z aktualnej sesji i członkostwa; identyfikator w URL wybiera kontekst, a nie nadaje uprawnienia. Payload nie może zawierać tożsamości firmy ani aktora.

## Model i wersje

Migracja `008_organization_branding.sql` dodaje `organization_settings` i `organization_logos`. Obie tabele mają klucz tenantowy `organization_id`, `ENABLE/FORCE RLS` i rolę runtime bez własności lub `BYPASSRLS`. Logo odwołuje się do ustawień tej samej firmy. Polityki odczytu sprawdzają aktywną firmę, tożsamość i członkostwo; zapisy wymagają `organization_admin`. Istniejący katalog platformowy `organizations` pozostaje oddzielny: runtime dostaje wyłącznie `UPDATE(name)`, z triggerem sprawdzającym firmę, aktora i rolę. Nie dostaje zmiany statusu ani tożsamości firmy.

Brak ustawień oznacza kolor `#163638`, brak logo i wersję 1. Pierwszy zapis materializuje ustawienia. Wszystkie zmiany nazwy, koloru i logo wymagają liczbowego `expectedVersion` i zwiększają wspólną wersję o 1. Logo przechowuje MIME, `BYTEA`, czas zmiany i wersję brandingu z chwili uploadu; usunięcie oraz ponowny upload nie resetują numeracji. Zmiana nazwy/koloru nie zmienia wersji bajtów istniejącego logo. Czasy pochodzą z PostgreSQL.

Sprawdzenie uprawnień, blokada firmy używana także przez członkostwa/zaproszenia, ponowne sprawdzenie uprawnień po oczekiwaniu, kontrola wersji, zmiana oraz `organization_audit_events` są w jednej transakcji. Audyt `branding_updated`, `logo_replaced`, `logo_removed` zapisuje aktora, firmę, poprzednią i nową wersję oraz odpowiednie pola/metadane. Nie zawiera bajtów obrazów ani sekretów. Błąd audytu wycofuje cały zapis. Konflikt zwraca 409 z aktualnym dozwolonym brandingiem; formularz zachowuje propozycję i wymaga jawnego odświeżenia.

## API

| Metoda i ścieżka (`/api/organizations/:id`) | Dostęp / payload |
|---|---|
| `GET /branding` | Aktywny członek; `{ branding: { organizationId, name, accentColor, version, logo } }`. Logo to `null` lub `{ mimeType, version }`. |
| `POST /branding` | Administrator; `{ name, accentColor, expectedVersion }`. Nazwa 1–200 znaków Unicode po przycięciu, bez znaków sterujących; kolor `#RRGGBB`, normalizowany do małych liter. |
| `GET /branding/logo?version=N` | Aktywny członek; obraz z poprawnym MIME, `nosniff` i `Content-Disposition: inline`. Opcjonalna wersja musi odpowiadać bieżącemu logo; brak lub stara wersja daje 404. |
| `POST /branding/logo` | Administrator; `{ mimeType, data, expectedVersion }`, `data` jako kanoniczne base64, bez prefiksu data URL. |
| `POST /branding/logo/delete` | Administrator; `{ expectedVersion }`. |

Każdy zapis wymaga cookie sesji, `X-CSRF-Token` i dokładnego `Origin`. UUID, typy, wersje i wszystkie pola są walidowane po stronie serwera; nadmiarowe pola są odrzucane. Wszystkie odpowiedzi API (także obrazy) mają `Cache-Control: no-store`, bez cache lub odpowiedzi 304 omijających autoryzację. Obcy i nieznany kontekst mają tę samą odmowę 403; brak sesji daje 401.

## Obrazy i UI

Upload i zapisane logo: najwyżej **256 KiB (262144 bajty)**. Obraz statyczny PNG, JPEG lub WebP, najwyżej **1024 × 1024**, do 1048576 pikseli. Tylko trasa uploadu ma większy limit body na base64; pozostałe zachowują dotychczasowe 8 KiB. Serwer sprawdza sygnaturę, format wykryty przez dekoder, wymiary i liczbę klatek. `sharp` jest przypiętą biblioteką dekodowania rastrów, bez nowego frameworka. Pełne dekodowanie z `failOn: warning` i ograniczeniem pikseli oraz ponowne kodowanie z limitem czasu odrzucają uszkodzone/ucięte obrazy i usuwają metadane oraz końcowe doklejone dane. SVG, GIF, animacje i MIME niezgodny z zawartością są odrzucane. Wynik jest ponownie ograniczony rozmiarem. Parametry dekodera: [dokumentacja Sharp](https://sharp.pixelplumbing.com/api-constructor/).

Przełącznik pokazuje nazwy i logo dostępnych firm; nagłówek wybranej firmy ma logo, nazwę i próbkę koloru. Brak logo daje inicjał. Kolor pozostaje dekoracją, nie zmienia kontrastu tekstu. Ustawienia są dostępne tylko administratorowi. Interfejs jest po polsku, z informacją o ładowaniu, błędach, zapisie, konflikcie i limitach uploadu. Zmiana wyboru natychmiast czyści poprzedni nagłówek/formularz; żądania są anulowane i powiązane z firmą, a obraz ma klucz firma + wersja. Brak browser storage i brandingu w konfiguracji środowiska.

## Weryfikacja i wydanie

`tests/organization-branding.test.ts` uruchamia prawdziwy PostgreSQL z logowaniem runtime `sitegrid`, testuje dwa tenanty, wspólne konto, role, FK/RLS, walidację obrazów, wersje, CSRF, równoległe zapisy, odebranie dostępu podczas oczekiwania oraz rollback audytu. Test migracji zachowuje wszystkie wypełnione tabele PR10 i dotychczasowe sumy migracji. `npm run check` obejmuje także istniejące konta, kontekst, zaproszenia i pracowników.

Kontrakt wydania wymaga schematu **8**, z upgrade ze schematów 0–8. Kod PR10 wymaga schematu 7: rollback kodu PR10 po migracji do 8 jest blokowany; użyj kontrolowanego restore backupu, nie downgrade SQL. Migracja nie edytuje zastosowanych plików ani danych PR10. Paczka zawiera natywny dekoder i jego zależności; weryfikacja wydania obejmuje jego uruchomienie z paczki zbudowanej przez `npm ci --omit=dev --ignore-scripts`.

Ograniczenia: M06 jest online; brak PWA/cache/offline i funkcji M07. Biblioteka dekodera i libvips wymagają utrzymywania poprawek bezpieczeństwa. Uploady są ograniczone bajtami, wymiarami i czasem dekodowania; globalne limity ruchu należą do konfiguracji wdrożenia. Linux x64 jest obsługiwanym artefaktem CI; arm64 nadal wymaga osobnego sprawdzonego wydania.
