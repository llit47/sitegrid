# SiteGrid — roadmapa małego MVP offline-first

Data: 2026-10-09. **Architektura kierunkowa przyjęta w PR #2; bez implementacji, limity nadal do zatwierdzenia.** Źródło decyzji: [architektura](ARCHITECTURE.md) i [macierz uprawnień](PERMISSIONS.md). Historyczny audyt referencji pozostaje w [FUNCTIONALITY.md](FUNCTIONALITY.md). Niniejszy plan zastępuje wcześniejszą kolejność z pilotażem online przed offline; wcześniejsze priorytety backlogu nie wyznaczają już bramki MVP.

## Aktualizacja modelu firmy i kontrahentów (2026-10-10)

Decyzja biznesowa: głównym scenariuszem jest jedna firma wykonawcza, wielu kontrahentów **bez kont** oraz wspólna pula pracowników przypisywanych indywidualnie do projektów i zadań. Zachowujemy wielofirmową izolację i dotychczasowe API. Bez stałych brygad i bez dostępu kontrahentów do aplikacji. Szczegółowy, **jeszcze niewdrożony** kontrakt: [MODEL_KONTRAHENTOW](../CONTRACTOR_PROJECT_MODEL.md). M09/PWA pozostaje bez zmian, M09C realizuje kontrahentów przed M10. M13 musi uwzględniać przedziały czasu i serwerową kontrolę kolizji dla pracownika we wszystkich projektach jego organizacji.

## Zakres i bramka pilotażu

MVP: fundament wielu izolowanych firm (codzienna praca jednej firmy wykonawczej), provisioning przez platformę, administracja kontami i pracownikami firmy, jednorazowa aktywacja, użytkownik w kilku firmach, branding w PostgreSQL, kontrahenci jako rekordy firmowe bez kont, projekty i indywidualnie przypisane zadania, postęp/przeszkody, własne wpisy pracy oraz odbiór online. Jedna PWA instalowana na Android/iOS. Offline-first dla odczytu przygotowanego zakresu i podstawowych zapisów musi działać przed pierwszym pilotażem, wraz z trwałością kolejki, retry, idempotencją i konfliktami.

Bez magazynu, zakupów, kalendarza, czatu, PDF/zdjęć, kosztów, pełnych brygad i rozbudowanego raportowania. Rezygnacja z tych modułów zmniejsza MVP, nie odkłada niezawodności. Administracja, przygotowanie urządzenia i odbiór robót pozostają online zgodnie z macierzą.

## Pierwszy działający przyrost — M01 (najbliższy PR implementacyjny)

**Zatwierdzona granica instalacji (2026-10-09):** SiteGrid instaluje się na przygotowanym Debianie 13 w LXC, VM, bare metal lub na hoście Proxmox VE; miejsce wybiera użytkownik. Provisioning LXC/VM na hoście Proxmox jest poza zakresem projektu.

**Obowiązkowy rezultat M01: instalowalny i uruchamialny SiteGrid z prawdziwym logowaniem**, a nie sam szkielet z atrapą konta. Instalacja, aktualizacja i rollback są kontraktem projektu od pierwszej wersji, nawet jeśli początkowo obsługują tylko podstawową aplikację.

- **Minimalna aplikacja:** React/TypeScript, Fastify, PostgreSQL z migracjami; strona logowania, panel dostępny dopiero po zalogowaniu, wylogowanie, `/health/live` i `/health/ready`. Brak publicznego endpointu rejestracji.
- **Pierwszy administrator platformy:** jednorazowy interaktywny bootstrap z CLI działającego lokalnie na serwerze, nie przez endpoint WWW; hasło Argon2id, sesja po stronie serwera w bezpiecznym cookie, unieważnianie przy wylogowaniu, limity prób logowania i ochrona żądań zmieniających stan. Żadnego stałego hasła demonstracyjnego ani sekretów w repo lub logach.
- **One-line installer na GOTOWYM Debianie 13:** operator najpierw sam tworzy LXC/VM/serwer z Debianem 13, a następnie wkleja jedno polecenie do jego powłoki. Instalator automatycznie pobiera zweryfikowane, wersjonowane wydanie, instaluje zależności, PostgreSQL, nginx, SiteGrid oraz systemd i prowadzi przez krótką konfigurację. Nie tworzy kontenerów/VM, nie blokuje hosta Proxmoxa z Debianem 13, nie wymaga wcześniejszego kopiowania `ops/` ani archiwów. Skrypt uruchamiany jako root musi pochodzić z zaufanego/podpisanego, przypiętego źródła; nie wykonywać niezweryfikowanego `curl main | bash` i nie nadpisywać istniejących danych.
- **Updater od dnia pierwszego:** `sitegrid update` pobiera określone wydanie, sprawdza integralność i zgodność, zachowuje konfigurację i DB, wykonuje backup przed migracją, uruchamia nowy release i weryfikuje gotowość usługi. W razie błędu zatrzymuje wdrożenie i raportuje, co pozostało aktywne.
- **Rollback od dnia pierwszego:** `sitegrid rollback` przełącza na wcześniejszy kompletny release tylko wtedy, gdy jest zgodny z obecną bazą. Nie wykonuje ślepego downgrade schematu; przy niezgodności blokuje komendę i wskazuje kontrolowany restore DB z backupu. Zachować dane w katalogu trwałym poza release.
- **Struktura:** `/opt/sitegrid/releases/<wersja>`, `/opt/sitegrid/current`, `/etc/sitegrid/` (sekrety; prawa dostępu), dane PostgreSQL poza release, usługi `systemd`. Całe wdrożenie i zarządzanie odbywają się WEWNĄTRZ istniejącego Debiana 13, bez provisioningu maszyn; sam host Proxmox VE z Debianem 13 jest dopuszczalnym miejscem instalacji.
- **Weryfikacja:** build, test logowania i odmowy bez sesji, odtwarzalna instalacja z JEDNEGO polecenia na czystym Debianie 13, test ponownego uruchomienia instalatora i wznowienia po przerwaniu, aktualizacji między dwiema testowymi wersjami, uszkodzonego wydania i rollbacku bez utraty konta. Testy na odizolowanym Debianie 13/systemd; nie wymaga się testów `pct` ani hosta Proxmox.
- **Brama akceptacji M01:** użytkownik wchodzi do już działającego, świeżego Debiana 13, wkleja jedno polecenie (bez wcześniejszego ręcznego transferu plików) i otrzymuje działającą usługę. Tworzy pierwszego administratora lokalnym CLI, loguje się z przeglądarki, wylogowuje, wykonuje prosty `sitegrid update` i bezpieczny `sitegrid rollback`. Kod i testy nie mogą zależeć od dostępu do API Proxmoxa. Publiczne GitHub Releases llit47/sitegrid dostarczają podpisany manifest i paczki bez uwierzytelnienia klienta; bootstrap/klucz są przypięte, a pierwsza publikacja wymaga zatwierdzenia użytkownika.

To **wąski pierwszy przyrost**, nie ukończone MVP. Obsługa wielu firm, zaproszenia, zaawansowane role i pełne offline-first pozostają w M02–M14. Nie wolno na podstawie działającego logowania ogłaszać gotowości do pilotażu z danymi prawdziwych firm.

## Małe PR-y implementacyjne po zatwierdzeniu

Identyfikatory M01–M15 są pozycjami planu, nie numerami GitHuba. Każdy PR ma jeden ocenialny rezultat; większy zakres dzielić dalej. Żaden z nich nie jest wykonywany w PR #2.

| ID | Zakres | Zależność | Kryterium zakończenia |
|---|---|---|---|
| M01 | **Działający fundament:** React/TS + Fastify + PostgreSQL, rzeczywiste logowanie administratora oraz od początku instalator jedno-poleceniowy na gotowy Debian 13 (także LXC), `sitegrid update`, `sitegrid rollback`, CI | Architektura PR #2 i rebranding PR #3 | Zalogowanie/wylogowanie, świeża instalacja, test aktualizacji i bezpiecznego rollbacku; wymagania szczegółowe wyżej. |
| M02 | Rozszerzenie minimalnego modelu PostgreSQL o firmy, członkostwa, role i izolację | M01 | Dwa tenanty, wspólny użytkownik, klucze złożone/RLS; izolacja puli połączeń. |
| M03 | Rozszerzenie zarządzania sesjami i uprawnieniami na kontekst wielu firm oraz odzyskiwanie dostępu | M02 | Zachowane bezpieczne logowanie z M01; odwołanie dostępu dla jednej firmy, brak przejęcia kontekstu innej firmy, testy sesji. |
| M04 | Firma i zaproszenie pierwszego administratora, aktywacja | M03 | Transakcja zużycia tokenu, wygaśnięcie, ponowne zaproszenie, GET bez skutku; test poczty bez produkcyjnych odbiorców. |
| M05 | Panel administratora firmy, pracownicy, role, dezaktywacja | M04 | Konto A+B i zaproszenie istniejącego konta; dezaktywacja tylko A; ochrona ostatniego administratora. |
| M06 | Branding i przełącznik firm | M05 | Nazwa, ustawienia i ograniczone logo `bytea` w DB; autoryzowany odczyt i brak mieszania kontekstów kart. |
| M07 | Projekty, przydziały i odczyt zadań | M05 | Uprawniony zakres i wersje rekordów; brak dostępu do obcego projektu. |
| M08 | Jedna komenda postępu: audyt, wersja i idempotencja | M07 | Atomowy wynik i audyt; utrata odpowiedzi po commicie, równoległe duplikaty, zmieniony payload z tym samym ID. |
| M09 | Instalowalna powłoka PWA i IndexedDB | M06–M07 | Android/iOS, restart offline po przygotowaniu; partycje konto/firma; brak sekretów sesji w storage. |
| M09C | Kontrahenci jako rekordy firmy i powiązanie z projektami | M09 oraz M07 | Migracja bez utraty istniejących projektów; jeden kontrahent dla wielu projektów; brak kont i uprawnień kontrahentów; RLS/testy między firmami i regresja PR13. |
| M10 | Pełny ograniczony snapshot projektu i odczyt offline | M09 + M09C | Spójny snapshot z autoryzowaną nazwą kontrahenta projektu, limity bez cichego ucięcia, atomowa wymiana bazy bez kasowania kolejki; brak fałszywego „gotowe offline”. |
| M11 | Trwała kolejka jednej komendy postępu i retry | M08–M10 | Atomowy zapis lokalny, restart PWA, timeout/5xx/429; synchronizacja na wznowieniu bez wymogu pracy w tle. |
| M12 | Konflikty, utrata dostępu i zmiana konta | M11 | Dwa urządzenia, brak cichego nadpisania, 401/403, kolejki A+B, lokalne wylogowanie i aktualizacja IndexedDB bez utraty pracy. |
| M13 | Własny wpis pracy i przeszkoda przez istniejącą kolejkę | M12 | Wpisy z rzeczywistym początkiem i końcem, własność, tworzenie/korekta offline; transakcyjny brak nakładania czasu jednego pracownika między projektami, konflikt przy synchronizacji bez utraty propozycji; brak duplikacji i cudzych edycji. W razie potrzeby podzielić implementację na kilka małych PR-ów. |
| M14 | Odbiór/zwrot online i mobilna „moja praca” | M12–M13 | Kierownik nie odbiera własnych robót; filtry, kontekst, stan synchronizacji i podstawowe akcje dotykowe. |
| M15 | Utrwalenie operacyjne: test odtworzenia, monitoring, obsługa migracji pełnego MVP i ponowna walidacja instalatora/updatera/rollbacku | M01 oraz M06; finalna weryfikacja po M14 | Gotowa procedura odtworzenia firm, logo, audytu i kolejki serwera na nowym LXC; zmierzony RPO/RTO, alert kopii/dysku, ponowne testy wydania. |

**Zasada stała od M01:** każdy kolejny PR implementacyjny musi dać się dostarczyć mechanizmem wydania, aktualizacji i rollbacku; schemat bazy ma jawnie oznaczoną zgodność wsteczną, a test regresji nie może zgubić kont i konfiguracji. M09–M12 są fundamentem produktu i częścią tej samej bramki MVP co konta oraz zadania. M07/M08 nie uzasadniają wcześniejszego pilotażu „tylko online”. M15 rozszerza istniejący już mechanizm instalacji i odtwarzania na pełne dane MVP; uruchomienie docelowej produkcji wymaga osobnego zadania wdrożeniowego.

## Obowiązkowy odbiór MVP

1. Platforma tworzy dwie firmy i pierwszych administratorów. Każdy administrator tworzy/przyjmuje konta tylko swojej firmy; nie zna obcych członkostw. Aktywacja jest jednorazowa i wygasająca.
2. Wspólny użytkownik ma różne role w A i B. Izolacja obejmuje listy, konkretne ID, branding, profile, audyt i komendy; dezaktywacja A nie blokuje B.
3. Na fizycznym Androidzie i iPhonie użytkownik instaluje PWA, przygotowuje projekt, odcina sieć, otwiera ponownie aplikację, zmienia postęp i tworzy wpis pracy. Kolejka pozostaje po zamknięciu/restarcie i synchronizuje się po wznowieniu.
4. Serwer zatwierdza komendę, lecz odpowiedź ginie. Retry daje jeden efekt i ten sam wynik. Zmiana wspólnego rekordu na drugim urządzeniu wyświetla konflikt i zachowuje lokalną propozycję, bez nadpisania.
5. Cofnięcie roli i wygasła sesja zatrzymują niewłaściwe zapisy; wylogowanie i przełączanie kont nie ujawniają danych poprzedniej osoby. Sprawdzony limit dostępu offline i brak możliwości natychmiastowego zdalnego czyszczenia są jawne.
6. Brak miejsca, niepełny snapshot, restart podczas wysyłki i aktualizacja PWA nie dają pozornego sukcesu ani nie kasują kolejki. Długie zerwanie połączenia nie wymaga Background Sync do odzyskania pracy.
7. Odtworzony PostgreSQL zachowuje firmy, członkostwa, branding, wpisy, audyt i identyfikatory komend; ponowienia po restore wymagają kontroli zgodności epoki synchronizacji opisanej niżej.

**Odtworzenie a retry:** kopia może pochodzić sprzed potwierdzonej komendy. Procedura restore zmienia serwerową epokę synchronizacji; klient wykrywa zmianę przed wysyłaniem, blokuje automatyczny replay i wymaga uzgodnienia lokalnego stanu z odtworzonym serwerem. Nie zakładać, że backup gwarantuje „dokładnie raz” wobec już utraconej historii. Ta obsługa jest częścią M12/M15.

## Po MVP

Oddzielne decyzje i małe PR-y: eksport raportów godzin dla kontrahentów bez udzielania im dostępu, opcjonalna obsługa wielu wykonawców jednego zadania (bez stałych brygad); dokumenty/zdjęcia z własną kolejką uploadu; magazyn oparty na ruchach; kalendarz; powiadomienia; koszty. Rozrost danych uzasadnia synchronizację przyrostową z bezpiecznym kursorem i tombstones. Każdy moduł definiuje swój zakres offline przed wejściem do pilotażu. Nie planuje się osobnej aplikacji natywnej.

Do zatwierdzenia: granice MVP, ważność aktywacji 24 h, dostęp offline do 7 dni, cele RPO/RTO i polityka retencji deduplikacji. Przed implementacją snapshotu określić jego limity i wersje docelowych przeglądarek; przed wdrożeniem domenę/HTTPS, pocztę i parametry hosta. Harmonogram kalendarzowy zależy od zespołu; nie jest deklarowany w tym PR.

## Przyrost PR11 — M06

M06 dodaje firmowe ustawienia i logo w PostgreSQL, administrację nazwy/koloru/logo, odczyt dla aktywnych członków oraz branding przełącznika i nagłówka firmy. Izolacja FORCE RLS, aktualne uprawnienia, kontrola wersji i transakcyjny audyt obejmują wszystkie zmiany. [Kontrakt implementacji i testy](../COMPANY_BRANDING.md). To zakres online M06; bramka offline-first MVP pozostaje bez zmian.

## Przyrost PR12 — M07

M07 dodaje projekty i jawne przydziały administratora firmy oraz planowanie, edycję i przypisywanie zadań przez przypisanych kierowników. Brygadzista odczytuje przypisane projekty, a pracownik własne zadania. Role pozostają firmowe; administracja firmy lub platformy nie nadaje domyślnego dostępu do zadań. FORCE RLS, złożone FK, bieżąca autoryzacja, wersje, archiwizacja i transakcyjny audyt obejmują ten zakres. [Kontrakt implementacji i testy](../PROJECTS_TASKS.md). Status zadania pozostaje początkowy; komendy postępu należą do M08. Ten przyrost jest online i nie zmienia bramki offline-first MVP.

## Przyrost PR13 — M08

M08 dodaje jeden endpoint komend v1 dla rozpoczęcia własnego zadania i zgłoszenia do odbioru, trwałe receipts PostgreSQL, kontrolę wersji oraz atomowy audyt. Retry ponownie sprawdza bieżącą sesję, role i przydział; utrata odpowiedzi po COMMIT i równoległe duplikaty mają jeden efekt. Schemat 10 zachowuje dane PR12. [Kontrakt i testy M08](../TASK_PROGRESS.md). Polski komponent pokazuje potwierdzony postęp i jawne konflikty. Odbiór/zwrot M14, PWA i kolejka offline pozostają poza tym przyrostem; bramka MVP nie zmienia się.
