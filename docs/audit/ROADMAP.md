# SiteGrid — roadmapa małego MVP offline-first

Data: 2026-10-09. **Architektura kierunkowa przyjęta w PR #2; bez implementacji, limity nadal do zatwierdzenia.** Źródło decyzji: [architektura](ARCHITECTURE.md) i [macierz uprawnień](PERMISSIONS.md). Historyczny audyt referencji pozostaje w [FUNCTIONALITY.md](FUNCTIONALITY.md). Niniejszy plan zastępuje wcześniejszą kolejność z pilotażem online przed offline; wcześniejsze priorytety backlogu nie wyznaczają już bramki MVP.

## Zakres i bramka pilotażu

MVP: wiele firm, provisioning przez platformę, administracja kontami i pracownikami firmy, jednorazowa aktywacja, użytkownik w kilku firmach, branding w PostgreSQL, projekty i przypisane zadania, postęp/przeszkody, własne wpisy pracy oraz odbiór online. Jedna PWA instalowana na Android/iOS. Offline-first dla odczytu przygotowanego zakresu i podstawowych zapisów musi działać przed pierwszym pilotażem, wraz z trwałością kolejki, retry, idempotencją i konfliktami.

Bez magazynu, zakupów, kalendarza, czatu, PDF/zdjęć, kosztów, pełnych brygad i rozbudowanego raportowania. Rezygnacja z tych modułów zmniejsza MVP, nie odkłada niezawodności. Administracja, przygotowanie urządzenia i odbiór robót pozostają online zgodnie z macierzą.

## Pierwszy działający przyrost — M01 (najbliższy PR implementacyjny)

**Obowiązkowy rezultat M01: instalowalny i uruchamialny SiteGrid z prawdziwym logowaniem**, a nie sam szkielet z atrapą konta. Instalacja, aktualizacja i rollback są kontraktem projektu od pierwszej wersji, nawet jeśli początkowo obsługują tylko podstawową aplikację.

- **Minimalna aplikacja:** React/TypeScript, Fastify, PostgreSQL z migracjami; strona logowania, panel dostępny dopiero po zalogowaniu, wylogowanie, `/health/live` i `/health/ready`. Brak publicznego endpointu rejestracji.
- **Pierwszy administrator platformy:** jednorazowy interaktywny bootstrap z CLI działającego lokalnie na serwerze, nie przez endpoint WWW; hasło Argon2id, sesja po stronie serwera w bezpiecznym cookie, unieważnianie przy wylogowaniu, limity prób logowania i ochrona żądań zmieniających stan. Żadnego stałego hasła demonstracyjnego ani sekretów w repo lub logach.
- **One-line installer dla Proxmox VE:** skrypt uruchamiany na hoście Proxmox tworzy nowy *nieuprzywilejowany* LXC Debian 13 (po weryfikacji dostępności szablonu, ID, storage, sieci i zasobów), po czym uruchamia instalator wewnątrz kontenera. W istniejącym Debianie 13 instalator wewnętrzny też ma działać jednym poleceniem. Pobrań nie opierać na ruchomym `main` w produkcji: wersjonowany artefakt, kontrola integralności, jawne potwierdzenie zmian i brak kasowania zastanych kontenerów/danych.
- **Updater od dnia pierwszego:** `sitegrid update` pobiera określone wydanie, sprawdza integralność i zgodność, zachowuje konfigurację i DB, wykonuje backup przed migracją, uruchamia nowy release i weryfikuje gotowość usługi. W razie błędu zatrzymuje wdrożenie i raportuje, co pozostało aktywne.
- **Rollback od dnia pierwszego:** `sitegrid rollback` przełącza na wcześniejszy kompletny release tylko wtedy, gdy jest zgodny z obecną bazą. Nie wykonuje ślepego downgrade schematu; przy niezgodności blokuje komendę i wskazuje kontrolowany restore DB z backupu. Zachować dane w katalogu trwałym poza release.
- **Struktura:** `/opt/sitegrid/releases/<wersja>`, `/opt/sitegrid/current`, `/etc/sitegrid/` (sekrety; prawa dostępu), dane PostgreSQL poza release, usługi `systemd`. Rozróżnić proces instalacji na hoście Proxmox i zarządzanie aplikacją w LXC.
- **Weryfikacja:** build, test logowania i odmowy bez sesji, odtwarzalna instalacja na czystym Debianie 13, test ponownego uruchomienia instalatora, aktualizacji między dwiema testowymi wersjami, uszkodzonego wydania i rollbacku bez utraty konta. Skrypt tworzenia LXC zweryfikować na testowym Proxmoxie przed uznaniem go za działający; sam mock poleceń `pct` nie wystarczy.
- **Brama akceptacji M01:** użytkownik potrafi jednym poleceniem zainstalować SiteGrid, założyć pierwszego administratora lokalnym CLI, zalogować się z przeglądarki, wylogować oraz wykonać `sitegrid update` i bezpieczny `sitegrid rollback`. Jeżeli realne testy Proxmoxa nie są dostępne, raport wyraźnie oznacza tę część jako **niezweryfikowaną**, a PR nie może deklarować gotowego instalatora hostowego.

To **wąski pierwszy przyrost**, nie ukończone MVP. Obsługa wielu firm, zaproszenia, zaawansowane role i pełne offline-first pozostają w M02–M14. Nie wolno na podstawie działającego logowania ogłaszać gotowości do pilotażu z danymi prawdziwych firm.

## Małe PR-y implementacyjne po zatwierdzeniu

Identyfikatory M01–M15 są pozycjami planu, nie numerami GitHuba. Każdy PR ma jeden ocenialny rezultat; większy zakres dzielić dalej. Żaden z nich nie jest wykonywany w PR #2.

| ID | Zakres | Zależność | Kryterium zakończenia |
|---|---|---|---|
| M01 | **Działający fundament:** React/TS + Fastify + PostgreSQL, rzeczywiste logowanie administratora oraz od początku instalator Proxmox/LXC, `sitegrid update`, `sitegrid rollback`, CI | Architektura PR #2 i rebranding PR #3 | Zalogowanie/wylogowanie, świeża instalacja, test aktualizacji i bezpiecznego rollbacku; wymagania szczegółowe wyżej. |
| M02 | Rozszerzenie minimalnego modelu PostgreSQL o firmy, członkostwa, role i izolację | M01 | Dwa tenanty, wspólny użytkownik, klucze złożone/RLS; izolacja puli połączeń. |
| M03 | Rozszerzenie zarządzania sesjami i uprawnieniami na kontekst wielu firm oraz odzyskiwanie dostępu | M02 | Zachowane bezpieczne logowanie z M01; odwołanie dostępu dla jednej firmy, brak przejęcia kontekstu innej firmy, testy sesji. |
| M04 | Firma i zaproszenie pierwszego administratora, aktywacja | M03 | Transakcja zużycia tokenu, wygaśnięcie, ponowne zaproszenie, GET bez skutku; test poczty bez produkcyjnych odbiorców. |
| M05 | Panel administratora firmy, pracownicy, role, dezaktywacja | M04 | Konto A+B i zaproszenie istniejącego konta; dezaktywacja tylko A; ochrona ostatniego administratora. |
| M06 | Branding i przełącznik firm | M05 | Nazwa, ustawienia i ograniczone logo `bytea` w DB; autoryzowany odczyt i brak mieszania kontekstów kart. |
| M07 | Projekty, przydziały i odczyt zadań | M05 | Uprawniony zakres i wersje rekordów; brak dostępu do obcego projektu. |
| M08 | Jedna komenda postępu: audyt, wersja i idempotencja | M07 | Atomowy wynik i audyt; utrata odpowiedzi po commicie, równoległe duplikaty, zmieniony payload z tym samym ID. |
| M09 | Instalowalna powłoka PWA i IndexedDB | M06–M07 | Android/iOS, restart offline po przygotowaniu; partycje konto/firma; brak sekretów sesji w storage. |
| M10 | Pełny ograniczony snapshot projektu i odczyt offline | M09 | Spójny snapshot, limity bez cichego ucięcia, atomowa wymiana bazy bez kasowania kolejki; brak fałszywego „gotowe offline”. |
| M11 | Trwała kolejka jednej komendy postępu i retry | M08–M10 | Atomowy zapis lokalny, restart PWA, timeout/5xx/429; synchronizacja na wznowieniu bez wymogu pracy w tle. |
| M12 | Konflikty, utrata dostępu i zmiana konta | M11 | Dwa urządzenia, brak cichego nadpisania, 401/403, kolejki A+B, lokalne wylogowanie i aktualizacja IndexedDB bez utraty pracy. |
| M13 | Własny wpis pracy i przeszkoda przez istniejącą kolejkę | M12 | Tworzenie/korekta offline, walidacja czasu, własność wpisu; brak duplikacji i cudzych edycji. |
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

Oddzielne decyzje i małe PR-y: brygady i raport zbiorczy; dokumenty/zdjęcia z własną kolejką uploadu; magazyn oparty na ruchach; kalendarz; powiadomienia; koszty. Rozrost danych uzasadnia synchronizację przyrostową z bezpiecznym kursorem i tombstones. Każdy moduł definiuje swój zakres offline przed wejściem do pilotażu. Nie planuje się osobnej aplikacji natywnej.

Do zatwierdzenia: granice MVP, ważność aktywacji 24 h, dostęp offline do 7 dni, cele RPO/RTO i polityka retencji deduplikacji. Przed implementacją snapshotu określić jego limity i wersje docelowych przeglądarek; przed wdrożeniem domenę/HTTPS, pocztę i parametry hosta. Harmonogram kalendarzowy zależy od zespołu; nie jest deklarowany w tym PR.
