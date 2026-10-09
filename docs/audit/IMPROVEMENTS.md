# SiteGrid — ulepszenia i priorytety

> Aktualizacja zakresu produktu (PR #2): poniższy backlog pozostaje zapisem rekomendacji po audycie. Obowiązujący projekt MVP i kolejność prac określają [ARCHITECTURE.md](ARCHITECTURE.md) oraz [ROADMAP.md](ROADMAP.md): offline-first jest warunkiem pierwszego pilotażu, a osobna aplikacja natywna jest poza zakresem produktu.


Data: 2026-10-09. **wnioskowana:** backlog własnego produktu oparty na potrzebach budowy oraz rzeczywistych obserwacjach V01–V30 z [FUNCTIONALITY.md](FUNCTIONALITY.md). Propozycja funkcji nie oznacza, że HERC jej nie ma. **niezweryfikowana:** dopasowanie do procesów użytkownika, liczba użytkowników i koszt realizacji.

**potwierdzona:** ograniczony audyt interaktywny zakończony: 30 widoków, 2 próby logowania, rola `worker`, bez zapisów biznesowych. Rozpoznano m.in. zadania w folderach, lokalną obecność i raporty, kalendarz oraz magazyn. Nie zweryfikowano zapisów ani innych ról.

## Co zmieniły obserwacje

| Dowód — potwierdzona | Wniosek dla własnej aplikacji — wnioskowana | Backlog |
|---|---|---|
| Lokalność raportów/godzin/kalendarza/magazynu mimo wspólnego nagłówka online (V17–V24). | Wspólna baza na serwerze od początku; lokalne szkice z jawnym statusem. Synchronizacja nie może być nieokreśloną obietnicą. | I03, I07–I09, I15 |
| Hierarchia projekt/folder/zadanie i plany przypisane do miejsca (V07–V13). | Zachować kontekst lokalizacji robót i dokumentów; nie kopiować mechanicznie układu menu. | I01, I06, I10 |
| Trzy statusy zadania i brak oddzielnego odbioru w badanym UI (V09/V14). | Uzgodnić wykonanie versus odbiór z kierownikiem; nie twierdzić, że HERC nie ma odbiorów w innym miejscu. | I06, I11 |
| Powrót z folderu do listy projektów, niejasny zakres liczników (V07–V11). | Naprawić semantykę nawigacji i agregacji w projekcie własnego UI. | I05, I06 |
| Globalna lista bez widocznych filtrów; część celów dotykowych 28–37 px (V14/V26–V30). | „Moja praca”, filtry oraz testy ergonomii na telefonie jako część podstawowego procesu. | I05 |
| Magazyn ma formularz jednostek i liczniki ruchów, ale jest pusty i lokalny (V24–V25). | Model ruchów i testy spójności nadal potrzebne; nie zakładać ręcznej edycji sald HERC. | I09 |

## Zasady priorytetu i estymacji

**wnioskowana:** P0 — warunek wiarygodnego projektu lub bezpiecznego pilotażu; P1 — niezbędny zakres operacyjny przed szerszym użyciem; P2 — opcjonalne rozszerzenie po poznaniu potrzeb. Trudność: S około 1–3, M 4–8, L 9–20 dni pracy doświadczonego programisty wraz z celowaną weryfikacją. To orientacyjne przedziały dla funkcji, nie zobowiązanie ani czas pojedynczego PR-a. Większe elementy dzielić zgodnie z roadmapą; nie sumować mechanicznie współdzielonych fundamentów.

| ID | Priorytet / konieczność | Propozycja — wnioskowana | Korzyść | Trudność | Zależność i miara odbioru |
|---|---|---|---|---|---|
| I00 | P0 / niezbędne poznanie | Potwierdzić procesy z reprezentantami pięciu ról i uzupełnić luki na danych syntetycznych. | Zakres wynika z potrzeb i dowodów. | M | Audyt odczytowy wykonany; pozostały macierz ról, obiegi zapisów i akceptacja MVP. |
| I01 | P0 / niezbędne | Izolacja firm, członkostwa, projekty, brygady i uprawnienia zasobowe. | Ochrona danych i właściwy podział odpowiedzialności. | L | Dwa syntetyczne tenanty; brak dostępu między nimi; role sprawdzane w API. |
| I02 | P0 / niezbędne | Uwierzytelnianie, unieważnianie sesji, jawne odebranie dostępu. | Rozliczalność działań i kontrola dostępu byłych współpracowników. | M | I01; dezaktywacja odcina sesje i synchronizację przy najbliższym połączeniu. |
| I03 | P0 / niezbędne | Historia zmian, transakcje i kontrola wersji. | Wyjaśnienie korekt i brak cichej utraty cudzej pracy. | L | I01–I02; zmiana i wpis audytu atomowe; konflikt wykrywany. |
| I04 | P0 / niezbędne | Spójna kopia bazy i plików, przećwiczone odtworzenie. | Możliwość odzyskania pracy po awarii hosta. | M | Ustalony zakres danych; odtworzona próbka relacji i załączników na osobnej instancji. |
| I05 | P1 / niezbędne | Widok „moja praca” na telefonie, czytelny kontekst budowy i krótkie formularze. | Szybsza obsługa na placu budowy. | M | I01; pracownik odnajduje zadanie i instrukcję w teście użyteczności. |
| I06 | P1 / niezbędne | Zadania, blokady, przydziały i odbiór oddzielony od zgłoszenia wykonania. | Lepsza koordynacja brygad i jakości. | L | I01–I03; pełen przebieg zadań testowych i poprawne ograniczenia ról. |
| I07 | P1 / niezbędne | Raport dzienny i ewidencja czasu z korektą i zatwierdzaniem. | Wiarygodne rozliczenie pracy bez ukrywania zmian. | L | I06; korekta zachowuje pierwotną wersję i powód. |
| I08 | P1 / niezbędne dla pracy terenowej | Lokalne szkice, kolejka synchronizacji, idempotencja i rozwiązywanie konfliktów. | Kontynuacja wybranych czynności przy słabym zasięgu. | L | I03, I05–I07; powtórzony zapis nie tworzy duplikatu, konflikt nie znika automatycznie. |
| I09 | P1 / niezbędne dla magazynu | Ruchy materiałowe, rezerwacje, jednostki i częściowe dostawy. | Stany możliwe do uzgodnienia z wydaniami na budowę. | L | I01–I03; konkurencyjne wydania nie przekraczają dostępnego stanu. |
| I10 | P1 / niezbędne | Wersje dokumentów i zdjęcia powiązane z zadaniem/usterką. | Praca na aktualnej dokumentacji i dowód wykonania. | M | I01, I04; sprawdzenie dostępu również przy pobieraniu pliku. |
| I11 | P1 / niezbędne | Rejestr usterek z odpowiedzialnym, terminem i odbiorem. | Kontrolowane domknięcie poprawek. | M | I06, I10; ponowne otwarcie zachowuje historię odbiorów. |
| I12 | P2 / opcjonalne | Powiadomienia i przypomnienia dobrane do roli. | Mniej przeoczonych terminów. | M | I06–I11; preferencje, brak duplikatów i ograniczenie szumu. |
| I13 | P2 / opcjonalne | Budżet, koszty i kontrolowane eksporty. | Przegląd ekonomiki projektu. | L | Wiarygodne dane źródłowe i odrębne uprawnienia finansowe. |
| I14 | P2 / opcjonalne | QR materiałów, aplikacja natywna, integracje księgowe/BIM. | Usprawnienia wyspecjalizowanych procesów. | L na funkcję | Potwierdzona potrzeba i stabilne API; oddzielne decyzje zakresowe. |
| I15 | P1 / zależne od procesu | Wspólny kalendarz firmy/projektu z kontrolą dostępu i strefą czasu. | Terminy widoczne na urządzeniach ekipy, bez mylenia wydarzenia z zadaniem. | M | I01–I03; dwa konta widzą ten sam dozwolony termin; aktualizacja nie dubluje wydarzenia. |

## Pięć rekomendacji o największej wartości

Wszystkie **wnioskowane**, po audycie odczytowym; do walidacji z użytkownikami:

1. **I01–I02: firmy, projekty i uprawnienia od początku.** Trudne do bezpiecznego dodania po zgromadzeniu danych.
2. **I05–I06: mobilna „moja praca” z czytelnym odbiorem.** Bezpośrednio wspiera codzienny przepływ robót.
3. **I03, I07–I08 i I15: wspólne raporty, godziny i terminy z jawną synchronizacją.** Odpowiada na lokalny charakter tych modułów w badanej konfiguracji HERC; historia i wersje chronią przed cichą utratą zmian.
4. **I09: magazyn oparty na ruchach.** Pozwala wyjaśniać zużycie i ograniczać przestoje materiałowe.
5. **I04 i I10: pliki lokalne z rewizjami i sprawdzonym odtwarzaniem.** Zapewnia kontrolę nad dokumentacją i ciągłość pracy.

## Decyzje, których nie należy podejmować na podstawie samej referencji

**wnioskowana:** nie kopiować automatycznie wszystkich modułów, kolorów ani układu HERC. Ustalić, które role rzeczywiście rejestrują czas, kto zatwierdza odbiór, czy magazyny są wspólne dla budów i jaki zakres offline jest konieczny. Dla MVP proponuje się jedną firmę właściciela na projekt; wspólna inwestycja wielu firm wymaga jawnego modelu udostępniania. Brak danych o tych procesach jest **niezweryfikowany**, a nie domyślną zgodą na najszerszy dostęp.

**wnioskowana:** zakres pilotażu: I01–I06 i podstawowe I10. Przed pracą w miejscach o słabym zasięgu potrzebne I08; przed obsługą rzeczywistego magazynu I09. P2 nie blokuje pierwszego pilotażu. Walidacja procesów I00 może zmienić tę kolejność. Kalendarz I15 włączyć do pilotażu, jeśli jest głównym narzędziem ustalania terminów.
