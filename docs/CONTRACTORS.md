# PR16 — M09C: kontrahenci i projekty

Kontrahent jest rekordem biznesowym istniejącej firmy. Nie tworzy organizacji, konta, członkostwa ani roli i nie otrzymuje logowania, zaproszeń lub dostępu do aplikacji. Jeden kontrahent może mieć wiele projektów swojej firmy; projekt może pozostać bez kontrahenta (wewnętrzny/historyczny). Przydziały osób, jeden wykonawca zadania i komendy M08 pozostają bez zmian. [Model produktu](CONTRACTOR_PROJECT_MODEL.md).

## Dane i uprawnienia

Migracja `011_contractors.sql` podnosi schemat **10 → 11**. `contractors` ma klucz `(organization_id, id UUID)`, nazwę 1–200 znaków po trim (bez znaków kontrolnych), status `active/inactive`, wersję dodatnią i czasy bazy `created_at/updated_at`. Nazwy nie muszą być unikalne. Tożsamość i data utworzenia są niezmienne; zapis zwiększa wersję dokładnie o 1. Brak endpointu usuwania i runtime DELETE/TRUNCATE. Dezaktywacja zachowuje rekord, audyt i wszystkie powiązania.

`projects.contractor_id` jest nullable. Złożony FK `(organization_id, contractor_id)` wskazuje kontrahenta tej samej firmy, bez kaskadowego usuwania. Wszystkie istniejące projekty dostają `NULL`; identyfikatory, wersje, czasy, przydziały, zadania, receipts i audyt nie zmieniają się. Guard bazy i API odrzucają nowe powiązanie z nieaktywnym kontrahentem. Zachowanie już istniejącego nieaktywnego powiązania pozwala edytować pozostałe metadane projektu lub go archiwizować.

Administrator firmy zarządza katalogiem. Pozostali użytkownicy otrzymują wyłącznie `{id, name, status}` przy projektach dostępnych według dotychczasowych uprawnień; nie pobierają katalogu. Kierownik/brygadzista/pracownik nadal wymagają własnego aktywnego przydziału projektowego do zadań. Administrator platformy nie ma wyjątku. Powiązanie nie nadaje uprawnień do projektów, pracowników ani zadań.

Tabela ma ENABLE/FORCE RLS. Odczyt SQL pozwala administratorowi własnej firmy na katalog, a członkowi projektu tylko na rekordy powiązane z jego dostępnymi projektami. API projektu wybiera tylko minimalne pola. Zapis RLS wymaga administracji firmy; runtime ma SELECT/INSERT i UPDATE wyłącznie name/status/version. Funkcje działają jako wywołujący. Zapisy i guardy powiązań współdzielą dotychczasową blokadę firmy. API sprawdza sesję, Origin/CSRF i ponownie uprawnienia po oczekiwaniu; audyt jest w tej samej transakcji. Żaden obcy ID nie ujawnia istnienia lub wersji rekordu.

## API

Wszystkie ścieżki są pod `/api/organizations/:id`, z `Cache-Control: no-store`:

- `GET /contractors`: katalog administratora (id/name/status/version/createdAt/updatedAt).
- `POST /contractors` z `{name}`: nowy aktywny rekord, 201.
- `POST /contractors/:contractorId/update` z `{name, status, expectedVersion}`: edycja lub aktywacja/dezaktywacja. Konflikt 409 zwraca aktualny autoryzowany `contractor`; brak/obcy rekord daje 404.
- `POST /projects` dodatkowo przyjmuje opcjonalne `contractorId: UUID | null`; pominięcie oznacza brak kontrahenta.
- `POST /projects/:projectId/update` przyjmuje ten sam opcjonalny parametr; **pominięcie zachowuje istniejące powiązanie**, `null` je usuwa. Obowiązują istniejące expectedVersion/archiwum/konflikty.
- `GET /projects` i `GET /projects/:projectId` dodają `contractor: {id,name,status} | null`. Filtr `GET /projects?contractorId=UUID` ogranicza już autoryzowany zakres; `contractorId=none` wybiera projekty bez kontrahenta. Obcy/nieistniejący UUID w filtrze daje pusty zakres, bez informacji o katalogu.

Nieaktywny, obcy lub nieistniejący kontrahent dla nowego powiązania daje identyczne 400. Niepoprawny payload, UUID, status i expectedVersion są odrzucane; firma/aktor/tożsamość nie są polami zapisu. Mutacje kontrahenta zapisują `contractor_created/updated/deactivated/reactivated`, przed/po wersji i statusie; audyt projektu zawiera ID kontrahenta przed/po zmianie. Błąd audytu wycofuje całą mutację.

## Interfejs i ograniczenia

Administrator ma osobny moduł katalogu: tworzenie, zmiana nazwy, aktywacja/dezaktywacja, stany ładowania/pustki/błędu i jawne ponowne wczytanie. Błąd zapisu/409 zachowuje propozycję; ponowne wczytanie zastępuje formularze edycji kontrahenta. Formularze projektu pozwalają wybrać aktywnego kontrahenta lub brak powiązania. Nieaktywny obecny kontrahent jest widoczny jako historyczny; nie jest opcją dla innych projektów. Nazwa/status są wyświetlane na liście i w szczegółach; filtr powstaje z dostępnych projektów, również dla pracownika bez dostępu do katalogu. Zmiana firmy odmontowuje kontekst i ignoruje spóźnione odczyty/zapisy.

Brak zmiany architektury PWA/IndexedDB: kontrahenci są danymi API online, nie trafiają do cache powłoki ani IndexedDB. Offline odmontowuje również widoki kontrahentów. M10–M12, wpisy godzin M13, raporty/eksporty, konta kontrahentów i zespoły pozostają poza PR16.

## Wydanie i walidacja

Kontrakt `release.json`: target/min/max **11**, upgrade 0–11. Paczka zawiera nową migrację i moduły kontrahentów. Update robi backup przed migracją; rollback do PR15 wymagającego wyłącznie 10 jest blokowany przed zatrzymaniem usługi. Nie ma downgrade SQL — niezgodny powrót wymaga kontrolowanego restore kopii sprzed migracji. Podpisy, installer i format paczki pozostają bez zmian.

`tests/contractors.test.ts` korzysta z rzeczywistego PostgreSQL 17 i nieuprzywilejowanego runtime: świeży schemat i upgrade z populowanymi danymi 10 (w tym receipt M08), katalogi dwóch firm, role, FK/RLS, wersje, audyt/rollback, równoległe edycje i odebrany dostęp po blokadzie. `tests/contractors-browser.mjs` sprawdza desktop/mobile, formularze, błędy/409, historyczne powiązania, filtr, spóźnione odpowiedzi przy przełączaniu firmy, minimalny zakres pracownika/brygadzisty i postęp w wielu projektach. Zestaw PWA dodatkowo sprawdza brak metadanych kontrahenta w cache i widoku offline. Wykonać też dotychczasowe zestawy browser i Python z rzeczywistą paczką. [Polecenia](DEVELOPMENT.md).

Chromium z mobilnym viewportem nie zastępuje testów na fizycznym Androidzie/iOS. Czysty Debian 13/systemd wymaga osobnego odbioru instalacji; testy instalatora/update/rollback używają istniejącej izolowanej infrastruktury testowej.

Walidacja lokalna 2026-10-10: Node 24.21.0, PostgreSQL 17.11 z oddzielną nieuprzywilejowaną rolą `sitegrid`; `npm run check` **162/162** (w tym 16 testów kontrahentów), zero pominięć. Wszystkie pięć zestawów Playwright/Chromium przeszło desktop/mobile; brak błędów runtime/CSP. Rzeczywista paczka Linux x64 i Python **56/56**, zero pominięć, w tym backup przed upgrade 10 → 11 i odmowa rollbacku do 10. Walidacje skryptów oraz `git diff --check` przeszły. Fizycznych urządzeń i czystego Debiana/systemd nie sprawdzono.
