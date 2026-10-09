# Roadmapa małego MVP offline-first

Data: 2026-10-09. **Projekt do zatwierdzenia w PR #2, bez implementacji.** Źródło decyzji: [architektura](ARCHITECTURE.md) i [macierz uprawnień](PERMISSIONS.md). Historyczny audyt referencji pozostaje w [FUNCTIONALITY.md](FUNCTIONALITY.md). Niniejszy plan zastępuje wcześniejszą kolejność z pilotażem online przed offline; wcześniejsze priorytety backlogu nie wyznaczają już bramki MVP.

## Zakres i bramka pilotażu

MVP: wiele firm, provisioning przez platformę, administracja kontami i pracownikami firmy, jednorazowa aktywacja, użytkownik w kilku firmach, branding w PostgreSQL, projekty i przypisane zadania, postęp/przeszkody, własne wpisy pracy oraz odbiór online. Jedna PWA instalowana na Android/iOS. Offline-first dla odczytu przygotowanego zakresu i podstawowych zapisów musi działać przed pierwszym pilotażem, wraz z trwałością kolejki, retry, idempotencją i konfliktami.

Bez magazynu, zakupów, kalendarza, czatu, PDF/zdjęć, kosztów, pełnych brygad i rozbudowanego raportowania. Rezygnacja z tych modułów zmniejsza MVP, nie odkłada niezawodności. Administracja, przygotowanie urządzenia i odbiór robót pozostają online zgodnie z macierzą.

## Małe PR-y implementacyjne po zatwierdzeniu

Identyfikatory M01–M15 są pozycjami planu, nie numerami GitHuba. Każdy PR ma jeden ocenialny rezultat; większy zakres dzielić dalej. Żaden z nich nie jest wykonywany w PR #2.

| ID | Zakres | Zależność | Kryterium zakończenia |
|---|---|---|---|
| M01 | Szkielet React/TS + Fastify, kontrakty, CI i konfiguracja instalacji | Zatwierdzony PR #2 | Build i health check; bez Supabase i danych firmy w `.env`. |
| M02 | PostgreSQL: tożsamości, firmy, członkostwa, role i izolacja | M01 | Dwa tenanty, wspólny użytkownik, klucze złożone/RLS; izolacja puli połączeń. |
| M03 | Sesje, logowanie/wylogowanie i bootstrap platformy | M02 | Brak publicznej rejestracji; kontrolowany bootstrap; odwoływalne sesje, CSRF i ograniczenie prób. |
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
| M15 | Testowy LXC Debian 13, systemd, backup i monitoring | M06; finalna weryfikacja po M14 | Poprawne mount pointy/UID/GID; DB odtworzona z logo w nowym LXC, zmierzony RPO/RTO, alert kopii/dysku. |

M09–M12 są fundamentem produktu i częścią tej samej bramki MVP co konta oraz zadania. M07/M08 nie uzasadniają wcześniejszego pilotażu „tylko online”. M15 opisuje przygotowanie i odtworzenie testowe; uruchomienie docelowej produkcji wymaga osobnego zadania wdrożeniowego.

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
