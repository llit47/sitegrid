# SiteGrid — macierz uprawnień i cykl kont

Data: 2026-10-09. Normatywna propozycja własnego produktu powiązana z [architekturą](ARCHITECTURE.md); nie opis uprawnień referencyjnego HERC. Wszystkie operacje podlegają autoryzacji API i izolacji danych. Ukrycie przycisku nie jest zabezpieczeniem.

## Role i zakresy

| Operacja | Administrator platformy | Administrator firmy | Kierownik | Brygadzista | Pracownik |
|---|---|---|---|---|---|
| Utworzenie/dezaktywacja firmy | Tak, audyt platformowy | Nie | Nie | Nie | Nie |
| Zaproszenie pierwszego administratora firmy | Tak | Nie dotyczy | Nie | Nie | Nie |
| Tworzenie/zapraszanie kont i dezaktywacja członkostw | Tylko pierwszy administrator lub jawne odzyskanie administracji | Własna firma | Nie | Nie | Nie |
| Role i profile pracowników | Bez domyślnej administracji kadrami | Własna firma; również kolejny administrator firmy | Odczyt niezbędnych przydziałów projektu | Odczyt niezbędnych przydziałów projektu | Własny profil i przydziały |
| Nadanie roli platformowej | Wyłącznie kontrolowana administracja platformy | Nie | Nie | Nie | Nie |
| Nazwa, logo, ustawienia firmy | Dane startowe przy utworzeniu | Własna firma | Odczyt kontekstu | Odczyt kontekstu | Odczyt kontekstu |
| Tworzenie projektu i członkostwa projektowe | Nie | Własna firma | Przydziały zadań już uprawnionych członków projektu | Nie | Nie |
| Odczyt zadań i wpisów projektu | Nie domyślnie | Tylko z osobną rolą projektową | Przypisane projekty | Przypisane projekty, bez danych kadrowych | Przydzielone zadania i własne wpisy |
| Tworzenie/planowanie zadań i zmiana wykonawcy | Nie | Tylko z rolą kierownika projektu | Przypisane projekty, online | Nie w MVP | Nie |
| Rozpoczęcie / zgłoszenie wykonania / przeszkody | Nie | Z rolą wykonawcy | Dla własnych przydziałów | Dla własnych przydziałów | Dla własnych przydziałów |
| Odbiór / zwrot zadania | Nie | Z rolą kierownika | Online; nie własne wykonanie | Nie | Nie |
| Wpis pracy i jego korekta | Nie | Z rolą projektową, własny wpis | Własny wpis | Własny wpis | Własny wpis |
| Odczyt audytu administracyjnego firmy | Tylko zdarzenia platformowe | Własna firma | Nie | Nie | Nie |
| Globalna blokada tożsamości / unieważnienie sesji | Tak, jawne uzasadnienie i audyt | Nie | Nie | Nie | Nie |

Brygadzista w małym MVP odczytuje postęp przypisanych projektów i zgłasza własną pracę. Zbiorcze raportowanie za brygadę i zarządzanie jej składem są poza MVP. Magazynier pojawi się wraz z magazynem; nie nadaje dziś dodatkowych uprawnień. Administrator firmy może mieć również rolę kierownika, ale nadanie jest jawne i audytowane. Rola platformowa nie dziedziczy ról firmowych. Ewentualny przyszły dostęp serwisowy wymaga oddzielnego, czasowego nadania — brak domyślnego impersonowania w MVP.

## Reguły bez wyjątków w interfejsie

1. Uprawnienie jest przecięciem: aktywne konto + aktywna firma + aktywne członkostwo + rola + zakres projektu + relacja do rekordu. Domyślnie odmowa. Rola w A nie daje żadnej roli w B, także gdy oba członkostwa należą do tej samej tożsamości.
2. Administrator firmy może nadać wyłącznie role firmowe ze zdefiniowanego katalogu w swojej firmie. Nie zmienia globalnego hasła/e-maila użytkownika ani profilu pracownika w innym tenancie. Dane pracownika są lokalne dla firmy, niezależne od tożsamości logowania.
3. Utworzenie konta oznacza zaproszenie i oczekujące członkostwo. Nowy użytkownik ustawia hasło przez jednorazową aktywację; istniejący przyjmuje zaproszenie po uwierzytelnieniu. W obu przypadkach sprawdzenie odbiorcy i aktualnego stanu zaproszenia. Brak publicznego signup i wspólnych haseł.
4. Dezaktywacja w firmie A blokuje wszystkie odczyty/zapisy A, logo, synchronizację i replay zapisanych odpowiedzi. Nie blokuje B ani nie usuwa historii. Globalna blokada przez platformę działa we wszystkich firmach. Dezaktywacja samego profilu pracownika powiązanego z kontem atomowo dezaktywuje jego członkostwo tej firmy.
5. Ostatni administrator firmy nie może zostać pozbawiony roli lub zdezaktywowany bez przekazania administracji; sprawdzenie transakcyjne chroni również przed równoległymi zmianami. Platformowe odzyskanie administracji wymaga audytu i nowego zaproszenia, nie obejścia aktywacji.
6. Przełącznik firmy nie zmienia właściciela rekordów i kolejek. Każdy endpoint, zadanie workera, snapshot i plik sprawdza zakres, także po cofnięciu uprawnienia. Brak masowego katalogu globalnych użytkowników dla administratorów firm.
7. Tworzenie firm/kont, aktywacja, nadawanie ról i odbiory wymagają sieci. Uprawnienie zapamiętane offline pozwala tylko na lokalną propozycję; serwer ocenia ją ponownie przy synchronizacji. Odrzucenie jest widoczne, nigdy zamieniane w pozorny sukces.
8. Po potwierdzeniu odebrania dostępu usuwa się cache i kolejkę tego zakresu, informując o niewysłanych operacjach. Natychmiastowe zdalne czyszczenie urządzenia offline nie jest możliwe; ograniczenia czasu i logowania opisuje architektura.

## Minimalne scenariusze odbioru

- Administrator A nie odczytuje ani nie zmienia firmy B przez podstawienie ID w listach, szczegółach, logo, pracownikach, zaproszeniach, snapshotach i komendach.
- Użytkownik A+B ma różne role i oddzielne kolejki; dezaktywacja A nie blokuje B, ale odrzuca późniejsze komendy A i dostęp do wcześniejszych wyników idempotencji.
- Administrator firmy nie nadaje sobie roli platformowej ani nie dezaktywuje globalnie istniejącego użytkownika. Zaproszenie tej samej osoby nie resetuje jej hasła.
- Aktywacja wygasła, anulowana i użyta ponownie jest odrzucana; skaner linków GET nie zużywa tokenu; przy wyścigu tylko jedna aktywacja skuteczna.
- Kierownik nie odbiera własnego wykonania; pracownik nie zmienia przydziału ani wpisu innej osoby. Role sprawdzane również podczas retry.
- RLS i klucze złożone blokują połączenie obcych tenantów; kontekst nie wycieka przez pulę połączeń ani proces workera.

Scenariusze są planem testów przyszłej implementacji, nie wykonanymi testami tego PR.

## Implementacja M07 w PR12

„Osobna rola projektowa” w macierzy oznacza jawną rolę roboczą `manager`, `foreman` lub `worker` w istniejącym katalogu firmy **oraz aktywne członkostwo konkretnego projektu**; nie wprowadza nowego globalnego systemu ról. Administrator zarządza metadanymi i członkostwami projektów swojej firmy bez automatycznego dostępu do zadań. Tworzenie/edycja/przydzielanie zadań wymaga roli `manager` i aktywnego przydziału. `foreman` odczytuje zadania przypisanych projektów, `worker` wyłącznie swoje. Rola platformowa nie daje wyjątków. Archiwizacja zachowuje uprawniony odczyt historii i blokuje zapisy. Szczegóły i wykonane scenariusze testów opisuje [kontrakt M07](../PROJECTS_TASKS.md); komendy postępu, odbiór i wpisy pracy pozostają dalszym zakresem roadmapy.

## Planowany model kontrahentów (decyzja 2026-10-10)

Kontrahent nie jest tenantem, użytkownikiem ani rolą. Nie otrzymuje zaproszeń, logowania, dostępu do API, projektów lub zadań. Jego dane są własnością organizacji, a powiązania z projektami muszą wymuszać tę samą organizację (FK/RLS). Administrator firmy zarządza kontrahentami; pozostałe role otrzymują co najwyżej minimalne metadane kontrahenta przypisanego do autoryzowanego projektu. Żadna rola nie uzyskuje przez to dostępu do innych projektów lub katalogu kontrahentów. Raporty godzin generuje wyłącznie osoba uprawniona w firmie; wysyłka raportu poza aplikację nie jest udzieleniem uprawnienia. Szczegóły: [model](../CONTRACTOR_PROJECT_MODEL.md). To **plan, nie funkcja PR13**.

## Implementacja M08 w PR13

Rozpoczęcie i zgłoszenie do odbioru wymagają własnego wykonawstwa, aktywnego przydziału i jawnej roli roboczej firmy (`worker`, `foreman` lub `manager`). Kierownik/brygadzista nie działają w imieniu wykonawcy. Administrator firmy z samą administracją ani platformy nie mają wyjątku. Po blokadzie transakcyjnej API ponownie sprawdza sesję, konto, firmę, członkostwo, role, projekt i wykonawcę, także przed zwrotem utrwalonego receipt. Cofnięcie dostępu blokuje stare wyniki i nowe komendy bez ujawniania obcych rekordów. Archiwum zachowuje uprawniony replay historii, blokując nowe mutacje. [Kontrakt M08](../TASK_PROGRESS.md); odbiór i zwrot należą do M14.
