# M03 — kontekst firmy i autoryzacja API

`GET /api/me/organizations` zwraca `{ organizations: [{ id, name, roles }] }` wyłącznie dla aktywnych członkostw użytkownika w aktywnych firmach. Role są jawne, posortowane i nie dziedziczą po sobie. Administrator platformy podlega tej samej regule; panel `/api/admin/organizations` zachowuje oddzielne uprawnienia do katalogu firm.

`GET /api/organizations/:id/context` zwraca `{ organization: { id, name, roles } }`. Wymaga niewygasłej sesji, niezablokowanego konta, aktywnej firmy i aktywnego członkostwa. Sam odczyt minimalnego kontekstu dopuszcza członkostwo bez ról (`roles: []`). Nieistniejąca i niedostępna firma zwracają identyczne 403; brak prawidłowej sesji — 401, niepoprawny UUID — 400. Odpowiedzi mają `Cache-Control: no-store`.

## Transakcja i RLS

Migracja `005_organization_access.sql` dodaje wyłącznie polityki SELECT do istniejących tabel z ENABLE/FORCE RLS. Przy pustym kontekście firmy pozwalają one odczytać własne aktywne członkostwa w aktywnych firmach oraz role tych członkostw. Polityka ról odwołuje się do członkostw również poprzez RLS. Nie umożliwiają zapisów ani odczytu członkostw innych użytkowników. Nie ma `SECURITY DEFINER`, wyłączania RLS, dodatkowego uprzywilejowanego połączenia ani kopiowania danych do tabeli poza RLS. [Zasady PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

Serwer rozpoczyna transakcję, odczytuje aktualną sesję z cookie i sprawdza `users.blocked_at`. Dopiero wtedy ustawia `sitegrid.user_id` przez parametryzowane `set_config(..., true)`. UUID użytkownika, członkostwa, roli ani nagłówki kontekstu przekazane przez klienta nie są źródłem tożsamości.

`withAuthorizedOrganization` wywołuje istniejący `withOrganization` z autoryzacją wykonywaną na tym samym połączeniu, **przed** ustawieniem `sitegrid.organization_id`. Autoryzacja odczytuje dostępne członkostwo i jego bieżące role przez polityki discovery RLS. Opcjonalna lista `requiredRoles` pochodzi wyłącznie z definicji endpointu na serwerze i wymaga co najmniej jednej wskazanej roli. Wszystkie kolejne zapytania korzystają z klienta przekazanego do callbacku; kontekst firmy ogranicza je przez dotychczasowe polityki tenantowe.

Oba ustawienia są lokalne dla transakcji. COMMIT i ROLLBACK je usuwają; błąd rollbacku powoduje usunięcie połączenia z puli. Nie używać sesyjnego SET, `pool.query` wewnątrz callbacku ani samodzielnego sterowania transakcją. Niskopoziomowy `withOrganization` pozostaje dostępny dla zaufanych operacji z wcześniej autoryzowanym identyfikatorem; endpointy używają `withAuthorizedOrganization`. RLS ogranicza zakres odczytu, a serwer autoryzuje aktora; rola SQL aplikacji i jej GUC są zaufaną granicą, nie mechanizmem przyjmowania danych od klienta.

Dostęp i role są sprawdzane od nowa przy każdym żądaniu. Dezaktywacja firmy/członkostwa, usunięcie członkostwa lub roli, blokada konta, wygaśnięcie i usunięcie sesji działają przy następnym żądaniu bez ponownego logowania.

## React i weryfikacja

Sekcja „Twoje firmy” wymaga jawnego wyboru; każde żądanie kontekstu zawiera UUID firmy w URL. Wybór jest tylko stanem komponentu w aktualnej karcie. Nie zmienia sesji, cookies, localStorage ani innych kart. Zmiana firmy usuwa poprzedni widok i anuluje poprzedni odczyt. Przycisk odświeżenia ponownie pobiera dostępne firmy i czyści wybór. Brak dostępu oraz błędy nie pokazują wcześniejszego kontekstu.

`tests/organization-context.test.ts` sprawdza API z rzeczywistym logowaniem SQL jako `sitegrid` bez superuser/BYPASSRLS/własności tabel. Obejmuje migrację 4 → 5, izolację A/B, wiele członkostw i ról, statusy, podszywanie się, odebranie dostępu, panel platformy i reset obu GUC na tym samym backendzie (pula o rozmiarze 1), także po błędach SQL/callbacku i równoległych żądaniach. Uruchomienie i zmienne bazy: [DEVELOPMENT.md](DEVELOPMENT.md). CI używa PostgreSQL 17 i wykonuje ten zestaw w `npm run check`.

Schemat ma wersję 5; `release.json` aktualizuje wyłącznie wymagany kontrakt schematu. Instalator, publikacja Releases, podpisy i update/rollback pozostają bez zmian.
