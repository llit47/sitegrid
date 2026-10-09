# PR9 — zaproszenia email i aktywacja administratora firmy

Migracja `006_invitations.sql` podnosi schemat 5 → 6, zachowując konta, sesje, firmy, członkostwa i role. Runtime otrzymuje INSERT do `users` i `credentials` oraz SELECT/INSERT/UPDATE do nowej tabeli z ENABLE/FORCE RLS. Nie otrzymuje UPDATE haseł, prawa obejścia RLS ani własności tabel. Kontrakt wydania wymaga schematu 6; poprzedni kontrakt nie pozwala na rollback do schematu 5.

## Obsługa

Administrator platformy tworzy firmę w dotychczasowym formularzu, podając email jej pierwszego administratora. `POST /api/admin/organizations` przyjmuje `{ name, administratorEmail }`; dotychczasowe `{ name }` nadal działa. Firma, zaproszenie i audyt powstają atomowo. Przycisk „Pierwszy administrator” pozwala sprawdzić stan, anulować i zastąpić zaproszenie, również dla wcześniej utworzonej firmy.

Platforma może wydać wyłącznie pierwsze zaproszenie z rolą `organization_admin`. Aktywowane pierwsze zaproszenie lub jakiekolwiek istniejące członkostwo zamyka tę ścieżkę. Nie ma domyślnej administracji użytkownikami firm ani odzyskiwania administracji przez platformę w tym PR.

Po aktywacji administrator firmy loguje się, wybiera firmę w istniejącym przełączniku i zaprasza użytkowników z jedną jawną rolą: `organization_admin`, `manager`, `foreman`, `worker`. Kierownik, brygadzista i pracownik nie mogą zapraszać. Role firmowe nie przyznają roli platformowej. Listy pokazują stany oczekujące, zaakceptowane, wygasłe i anulowane.

Odbiorca otwiera `/invitations/accept#TOKEN`. Fragment nie trafia do serwera/proxy w URL, a React usuwa go z bieżącego wpisu historii i przechowuje tylko w pamięci karty. Odświeżenie wymaga ponownego otwarcia oryginalnego linku. Inspekcja nie zużywa zaproszenia. Nowe konto podaje zaproszony email i ustawia hasło 12–128 znaków, zapisane przez istniejący Argon2id, po czym loguje się standardowo. Istniejące konto musi najpierw zalogować się na zaproszony email. Inspekcja nie ujawnia emaila ani tego, czy konto istnieje; błędy akceptacji są ogólne.

Akceptacja tworzy wyłącznie członkostwo wskazanej firmy. Inne firmy i ich role pozostają bez zmian. Jeśli odbiorca już ma aktywne członkostwo w docelowej firmie, zaproszenie zostaje zużyte bez zmiany jego statusu i ról. Członkostwo oczekujące/nieaktywne powoduje odmowę; zaproszenie nie służy do reaktywacji ani zmiany istniejących ról. Wybór firmy nadal jest lokalny dla karty i nie zmienia sesji.

[PR10 (M05)](COMPANY_MEMBERS.md) dodaje osobne, autoryzowane działania zmiany ról i reaktywacji. Współdzieli blokadę firmy z zaproszeniami i ponownie sprawdza uprawnienia wystawcy po oczekiwaniu na blokadę. Zaproszenia zachowują powyższe zasady; migracja do schematu 7 nie zmienia ich istniejących rekordów.

## API i zabezpieczenia

- Platforma: GET/POST `/api/admin/organizations/:id/invitations` oraz POST `/:invitationId/revoke`. POST przyjmuje `{ email }`. Lista i anulowanie dotyczą wyłącznie pierwszych zaproszeń.
- Administrator firmy: GET/POST `/api/organizations/:id/invitations` oraz POST `/:invitationId/revoke`. POST przyjmuje `{ email, role }`.
- Odbiorca: POST `/api/invitations/inspect` z `{ token }`; odpowiedź zawiera tylko stan i nazwę aktywnej firmy dla oczekującego zaproszenia. POST `/api/invitations/accept` z `{ token }` dla zalogowanego odbiorcy lub `{ token, email, password }` dla nowego konta. GET nie aktywuje konta.

Każdy POST, także inspekcja, wymaga istniejącej sesji, CSRF i zgodnego Origin. Oba endpointy odbiorcy mają wspólny trwały limit 60 prób/IP/15 minut. API ma `Cache-Control: no-store`. Token ma 256 losowych bitów; baza zapisuje wyłącznie SHA-256. Ważność wynosi 24 godziny. Polityka odczytu po hashu pozwala znaleźć tylko zaproszenie posiadacza tokenu i nie pozwala na zapisy. Następnie serwer ustawia zweryfikowany kontekst firmy lokalnie dla transakcji. Wszystkie GUC są usuwane przy COMMIT/ROLLBACK.

Blokada transakcyjna firmy serializuje wydawanie, zastępowanie, anulowanie i akceptację; akceptacja dodatkowo blokuje wiersz zaproszenia. Ponownie sprawdza stan, aktualne uprawnienie wystawcy, aktywną firmę i tożsamość odbiorcy. Końcowy warunkowy UPDATE używa `clock_timestamp()`, również po oczekiwaniu na blokady i hashowaniu hasła. Konto, hasło, nowe członkostwo, rola, zużycie tokenu i audyt są jedną transakcją. Unikalność emaila i członkostwa chroni również przed równoległymi zaproszeniami do różnych firm.

Nowe zaproszenie anuluje poprzednie niezużyte linki do tego emaila w tej firmie. Zastąpienie pierwszego administratora anuluje poprzedni pierwszy link także przy zmianie emaila. Tokenów ani hashy nie ma w listach, odpowiedziach publicznych, audycie czy logach aplikacji. SMTP debug/logger są wyłączone; surowe błędy SMTP nie trafiają do logów.

## SMTP

Ustaw w chronionym środowisku procesu (na instalacji Debian: `/etc/sitegrid/sitegrid.env`, potem `systemctl restart sitegrid`): `SMTP_HOST`, `SMTP_PORT` (domyślnie 587), `SMTP_SECURE` (`true` dla bezpośredniego TLS, zwykle port 465; `false` dla STARTTLS), `SMTP_FROM` (sam adres email). `SMTP_USER` i `SMTP_PASSWORD` są opcjonalne dla relay i muszą być podane razem. Produkcja wymaga zweryfikowanego TLS lub STARTTLS; nie ma opcji wyłączania weryfikacji certyfikatu. Link powstaje z `PUBLIC_ORIGIN`, nigdy z nagłówka Host.

Bez SMTP można jawnie ustawić `INVITATION_MANUAL_LINKS=true` wyłącznie w development/test. Link jest zwracany jednorazowo tylko w odpowiedzi na autoryzowane wydanie przez admina i można go zaznaczyć/skopiować w formularzu. Nie można odczytać go ponownie z listy. Produkcja odrzuca konfigurację ręcznych linków i odmawia wydawania zaproszeń bez SMTP. Pozostała aplikacja może działać bez SMTP.

SMTP jest wysyłane po commicie. Odpowiedź `delivery` to `sent`, `failed` lub developerskie `manual`. `failed` pozostawia zapisane oczekujące zaproszenie i pokazuje adminowi instrukcję poprawienia SMTP oraz wydania nowego linku. W tym PR nie ma trwałej kolejki ani automatycznych retry: awaria pomiędzy commitem a wysyłką wymaga zastąpienia zaproszenia. Przy timeout relay mógł już przyjąć wiadomość; zastąpienie unieważnia poprzedni link. `sent` oznacza przyjęcie przez SMTP, nie gwarantuje doręczenia do skrzynki. Sprawdzenie realnego relay i doręczenia należy wykonać na docelowym środowisku; testy używają wyłącznie lokalnego SMTP.

## Weryfikacja

`tests/invitations.test.ts`: migracja 5 → 6, rzeczywiste logowanie SQL jako `sitegrid`, pierwszy administrator, nowe/istniejące konta, różne role w wielu firmach, brak nadpisania członkostw/haseł, użyty/wygasły/anulowany/zastąpiony link, zły odbiorca, równoległa akceptacja, odebrane uprawnienia wystawcy, CSRF, RLS, izolacja firm, reset GUC, rollback audytu, limit prób i ograniczenia produkcji. Lokalny serwer SMTP sprawdza wysyłkę oraz odmowę relay bez TLS w produkcji.

Użyj tych samych `TEST_DATABASE_URL` i `TEST_RUNTIME_DATABASE_URL` jak w [DEVELOPMENT.md](DEVELOPMENT.md). `npm run check` uruchamia typy, compiler lint (nieużywane deklaracje/parametry), build i wszystkie testy TypeScript. Osobno: `node --import tsx --test tests/invitations.test.ts`.
