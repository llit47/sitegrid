# Własna aplikacja — ulepszenia i priorytety

Data: 2026-10-09. **wnioskowana:** cały backlog to propozycja na podstawie celu użytkownika i scenariuszy budowlanych. Nie dowodzi przewagi nad HERC, którego nie zbadano. **niezweryfikowana:** dopasowanie do rzeczywistych procesów, liczba użytkowników i koszty realizacji. Dowody blokady: [FUNCTIONALITY.md](FUNCTIONALITY.md).

**potwierdzona:** nie zaobserwowano żadnego modułu HERC i nie wykonano zapisów w aplikacji (E03). Rekomendacje nie są listą wykrytych braków referencji.

## Zasady priorytetu i estymacji

**wnioskowana:** P0 — warunek wiarygodnego projektu lub bezpiecznego pilotażu; P1 — niezbędny zakres operacyjny przed szerszym użyciem; P2 — opcjonalne rozszerzenie po poznaniu potrzeb. Trudność: S około 1–3, M 4–8, L 9–20 dni pracy doświadczonego programisty wraz z celowaną weryfikacją. To orientacyjne przedziały dla funkcji, nie zobowiązanie ani czas pojedynczego PR-a. Większe elementy dzielić zgodnie z roadmapą; nie sumować mechanicznie współdzielonych fundamentów.

| ID | Priorytet / konieczność | Propozycja — wnioskowana | Korzyść | Trudność | Zależność i miara odbioru |
|---|---|---|---|---|---|
| I00 | P0 / niezbędne poznanie | Dokończyć ograniczony audyt i potwierdzić procesy z reprezentantami pięciu ról. | Zakres wynika z potrzeb i dowodów. | M | E01–E02 usunięte; mapa ma dowody i jawne luki, proces MVP zaakceptowany. |
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

## Pięć rekomendacji o największej wartości

Wszystkie **wnioskowane**, do walidacji po audycie:

1. **I01–I02: firmy, projekty i uprawnienia od początku.** Trudne do bezpiecznego dodania po zgromadzeniu danych.
2. **I05–I06: mobilna „moja praca” z czytelnym odbiorem.** Bezpośrednio wspiera codzienny przepływ robót.
3. **I03 i I08: historia, wersje i jawna synchronizacja.** Chroni przed utratą zmian i niepewnością, czy zapis dotarł.
4. **I09: magazyn oparty na ruchach.** Pozwala wyjaśniać zużycie i ograniczać przestoje materiałowe.
5. **I04 i I10: pliki lokalne z rewizjami i sprawdzonym odtwarzaniem.** Zapewnia kontrolę nad dokumentacją i ciągłość pracy.

## Decyzje, których nie należy podejmować na podstawie samej referencji

**wnioskowana:** nie kopiować automatycznie wszystkich modułów, kolorów ani układu HERC. Ustalić, które role rzeczywiście rejestrują czas, kto zatwierdza odbiór, czy magazyny są wspólne dla budów i jaki zakres offline jest konieczny. Dla MVP proponuje się jedną firmę właściciela na projekt; wspólna inwestycja wielu firm wymaga jawnego modelu udostępniania. Brak danych o tych procesach jest **niezweryfikowany**, a nie domyślną zgodą na najszerszy dostęp.

**wnioskowana:** zakres pilotażu: I01–I06 i podstawowe I10. Przed pracą w miejscach o słabym zasięgu potrzebne I08; przed obsługą rzeczywistego magazynu I09. P2 nie blokuje pierwszego pilotażu. Audyt I00 może zmienić tę kolejność.
