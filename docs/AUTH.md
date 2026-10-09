# Logowanie i pierwszy administrator

Przygotuj migracje zgodnie z [DEVELOPMENT.md](DEVELOPMENT.md). Na serwerze, z lokalnego terminala:

```sh
node --env-file=.env --import tsx apps/server/src/bootstrap-cli.ts
# produkcyjny build, z chronioną konfiguracją załadowaną przez operatora:
node dist/server/bootstrap-cli.js
```

CLI prosi o email i dwukrotnie o niewidoczne hasło (12–128 znaków). Nie przyjmuje haseł jako argumentów ani zmiennych środowiskowych; nie używaj historii powłoki do podawania hasła. Jedna transakcja blokuje wiersz instalacji, zapisuje konto, Argon2id, uprawnienie platformowe i audyt oraz trwale zamyka bootstrap. Ponowienie/równoległa próba jest odrzucana. Nie ma kont demonstracyjnych, publicznej rejestracji ani endpointu bootstrap. Usunięcie administratora nie otwiera bootstrapu ponownie.

Otwórz stronę SiteGrid i zaloguj się utworzonym kontem. Panel odczytuje chronione `/api/admin/overview`. Wylogowanie usuwa sesję z PostgreSQL i cookie z przeglądarki. Restart API zachowuje konta i niewygasłe sesje; nie usuwa limitów prób.

W produkcji `PUBLIC_ORIGIN` musi być dokładnym origin HTTPS (bez końcowego `/`). Cookie `__Host-sitegrid`: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, bez Domain; losowy sekret 256 bitów, w bazie wyłącznie jego SHA-256. Sesja uwierzytelniona ma absolutny termin 12 godzin, anonimowa do pobrania CSRF — 30 minut. Logowanie zmienia identyfikator i CSRF. Frontend nie zapisuje sekretów w localStorage/IndexedDB.

Każdy POST logowania/wylogowania oraz tworzenia firmy wymaga poprawnego CSRF i zgodnego `Origin`; odpowiedzi API nie są cache'owane. Nieznane/nieaktywne konto i błędne hasło zwracają taki sam komunikat, z weryfikacją Argon2 również dla nieznanego konta. Argon2id: 64 MiB, 3 iteracje, parallelism 1; pomiar w tym środowisku około 110 ms, przed wdrożeniem należy zmierzyć na docelowym LXC. Limity atomowe w PostgreSQL: 10 prób/konto i 30/IP na 15 minut; inicjalizacja sesji 120/IP na 15 minut. Zablokowanie konta jest sprawdzane przy każdym odczycie sesji.

API słucha na `127.0.0.1`, ufa nagłówkom proxy wyłącznie z `127.0.0.1` w produkcji. Reverse proxy musi **zastąpić** `X-Forwarded-For` rzeczywistym adresem klienta, zamiast przyjmować dowolny nagłówek od klienta. HTTPS i proxy wymagają sprawdzenia w instalacji. Logi nie zawierają payloadów logowania, cookies ani surowych błędów bazy.

M02A dodaje sekcję „Firmy” wyłącznie dla administratora platformy. `GET /api/admin/organizations` zwraca `{ organizations: [...] }`; `POST /api/admin/organizations` przyjmuje wyłącznie `{ name: string }` i zwraca 201 z `{ organization: ... }`. Nazwa po usunięciu skrajnych białych znaków musi mieć 1–200 znaków Unicode, bez znaków sterujących. Firma ma UUID, nazwę, status `active` (schemat dopuszcza też `inactive`) i `createdAt`. Utworzenie i audyt `organization_created` z `actor_id` oraz `organization_id` są jedną transakcją. Brak uwierzytelnionej sesji daje 401, brak uprawnienia platformowego lub niepoprawny CSRF/Origin — 403, błędne dane — 400.

Globalne konta i `platform_admins` pozostają bez zmian. M02B wprowadza członkostwa, role i RLS, a M03 dodaje [odczyt dostępnych firm i autoryzowany kontekst](ORGANIZATION_CONTEXT.md). Użytkownicy widzą swoje aktywne firmy w sekcji „Twoje firmy”; uprawnienie platformowe nie daje dostępu do ich kontekstu. PR9 dodaje [zaproszenia email i aktywację administratora firmy](INVITATIONS.md), bez publicznej rejestracji i zmiany istniejących członkostw.

PR9 rozszerza tworzenie firmy o opcjonalny `administratorEmail`; panel wymaga tego pola dla nowych firm. Zasady SMTP, aktywacji i stanów zaproszeń: [INVITATIONS.md](INVITATIONS.md).
