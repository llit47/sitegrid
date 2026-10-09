# HERC — mapa funkcjonalności i stan audytu

Data: 2026-10-09. Aplikacja referencyjna: https://herc-zarzadzanie-budowa.vercel.app/.

## Status i sposób czytania

**Audyt interaktywny nie został wykonany.** Ten dokument rejestruje fakty dotyczące przygotowania, brak dowodów produktowych i plan dokończenia. Nie jest kompletną mapą działającej aplikacji. Architektura i backlog w pozostałych plikach są propozycjami własnego produktu, a nie opisem implementacji HERC.

- **potwierdzona** — obserwacja bezpośrednia; wskazujemy jej źródło i zakres.
- **wnioskowana** — hipoteza lub rekomendacja z uzasadnieniem; nie dowodzi właściwości HERC.
- **niezweryfikowana** — element, którego istnienia lub zachowania nie sprawdzono.

Oznaczenie przy akapicie lub w nagłówku tabeli obejmuje wszystkie zawarte w nim stwierdzenia. „Niezweryfikowana” nie oznacza „funkcji brak”.

## Rejestr dowodów

| ID | Status | Ustalenie | Podstawa |
|---|---|---|---|
| E01 | potwierdzona | Proces audytu nie otrzymał niepustych `HERC_LOGIN` i `HERC_PASSWORD`. | Sprawdzono wyłącznie wartości logiczne dostępności zmiennych; nie odczytywano plików z sekretami. |
| E02 | potwierdzona | Brak narzędzia interaktywnej przeglądarki w udostępnionym katalogu narzędzi; brak pakietu Python Playwright oraz poleceń Node.js, npm, Chromium i Chrome w PATH. | Lokalna kontrola dostępności. Nie wyklucza nieznanej instalacji poza PATH. |
| E03 | potwierdzona | 0 prób logowania, 0 otwartych widoków, 0 zaobserwowanych modułów, 0 operacji zapisu w HERC. | Nie uruchomiono sesji przeglądarki ani żądań do aplikacji. |
| E04 | potwierdzona | Nie instalowano zależności i nie wdrażano usług. Nie zbierano zrzutów ekranu, cookies, tokenów ani danych użytkowników HERC. | Zakres wykonanych działań: przygotowanie dokumentacji. |
| E05 | niezweryfikowana | Dostępność aplikacji, rola konta, nawigacja, formularze, dane, backend i zachowanie na telefonie. | Brak sesji. |

## Brakujące wymagania do dokończenia

**potwierdzona:** blokady E01–E02 uniemożliwiają realizację interaktywnego zakresu. Potrzebne są:

1. Wstrzyknięcie obu zmiennych przez bezpieczny mechanizm środowiska, bez podawania ich wartości w czacie, argumentach poleceń lub plikach repozytorium.
2. Udostępniona przeglądarka sterowalna interaktywnie lub działający Playwright z binarium przeglądarki i dozwolonym połączeniem do aplikacji. Nie instalowano ich w tej sesji.
3. Konto z uprawnieniami do oglądania reprezentatywnych danych. Rzeczywistą rolę trzeba ustalić po zalogowaniu; scenariusze innych ról pozostają niezweryfikowane bez ich legalnie udostępnionych kont.

**wnioskowana:** dedykowany tenant demonstracyjny ze sztucznymi danymi ułatwi późniejsze testy zapisów. Obecne zlecenie nie zezwala na takie operacje na danych rzeczywistych.

## Mapa zaobserwowanych funkcji

**potwierdzona:** zbiór zaobserwowanych funkcji jest pusty (E03). Nie przypisano HERC żadnych nazw modułów, pól, statusów ani filtrów.

Poniżej znajduje się **lista obszarów do sprawdzenia**, a nie odtworzenie menu. Przeznaczenie jest **wnioskowane** z potrzeb opisanej aplikacji budowlanej. Obecność wszystkich obszarów w HERC jest **niezweryfikowana**.

| ID | Potencjalny obszar — niezweryfikowana | Co ustalić w UI — niezweryfikowana | Przeznaczenie na budowie — wnioskowana |
|---|---|---|---|
| F01 | Dostęp i sesja | Pola logowania, komunikaty, rola, wylogowanie; nie wywoływać resetu hasła. | Przypisanie działań do właściwego użytkownika. |
| F02 | Nawigacja i pulpit | Dostępne sekcje, kontekst firmy/projektu, skróty, okres zestawień. | Poranny przegląd opóźnień i blokad. |
| F03 | Firmy i projekty | Lista, szczegóły, uczestnicy, filtrowanie, archiwizacja widoczna w UI. | Rozdzielenie budów i odpowiedzialności firm. |
| F04 | Brygady i osoby | Członkostwo, przypisania, daty obowiązywania, ograniczenia widoczności. | Przydział zasobów przez brygadzistę bez ujawniania danych innych ekip. |
| F05 | Zadania i harmonogram | Lista/kalendarz, szczegóły, termin, wykonawca, zależności, statusy i filtry. | Kolejność robót, przekazanie pracy, wskazanie blokad. |
| F06 | Raporty dzienne i czas pracy | Formularze, zakres czasu, zatwierdzanie, korekty, podsumowania. | Rozliczenie wykonanej pracy i przekazanie informacji zmianie. |
| F07 | Materiały i magazyn | Jednostki, lokalizacje, stany, rezerwacje, przyjęcia/wydania, historia. | Dostępność materiału przed rozpoczęciem robót. |
| F08 | Zapotrzebowania i dostawy | Pozycje, ilości, akceptacja, terminy, częściowe dostawy. | Zapobieganie przestojom związanym z zakupami. |
| F09 | Dokumenty i zdjęcia | Metadane, wersje, powiązania, uprawnienia, podgląd bez pobierania zbiorowego. | Dostęp do właściwej rewizji rysunku i dowodów wykonania. |
| F10 | Usterki i odbiory | Lokalizacja, odpowiedzialny, termin, załączniki, ścieżka weryfikacji. | Domknięcie poprawek i odbiór robót. |
| F11 | Koszty i zestawienia | Zakres kosztów, okresy, grupowanie, filtry; nie uruchamiać eksportu. | Porównanie wykonania z planem przez kierownika. |
| F12 | Administracja i historia | Role, zakresy dostępu, ustawienia, zdarzenia zmian, powiadomienia. | Odebranie dostępu i wyjaśnienie, kto zmienił ustalenia. |

## Scenariusze ról

Każdy scenariusz to **wnioskowana** potrzeba własnego produktu; dostępność i możliwość ukończenia w HERC są **niezweryfikowane**.

| Rola | Przebieg i zależności | Wynik na budowie | Bezpieczna część przyszłego audytu |
|---|---|---|---|
| Kierownik budowy | Wybiera projekt → sprawdza zadania i blokady → porównuje raporty i dostępność materiałów → planuje odbiór. | Wiadomo, co blokuje termin i kto odpowiada za rozwiązanie. | Odczytać pulpit, listę i pojedynczy szczegół; nie zmieniać przydziałów. |
| Brygadzista | Sprawdza zadania brygady → obsadę → postęp → przygotowuje raport dzienny. | Jasny zakres pracy i przekazanie informacji kierownikowi. | Obejrzeć zakres brygady i pusty formularz wyłącznie po ustaleniu, że samo otwarcie nie zapisuje. |
| Pracownik | Otwiera „moje zadania” → instrukcję/rewizję → zgłasza postęp lub przeszkodę. | Mniej niejasności co do miejsca i zakresu robót. | Ocenić odczyt zadania na telefonie; zgłoszenie pozostaje nietestowane. |
| Magazynier | Sprawdza zapotrzebowanie → stan/rezerwacje → wydaje materiał → wiąże ruch z projektem. | Możliwość ustalenia, gdzie zużyto materiał. | Odczytać listę i historię; nie rezerwować ani wydawać. |
| Administrator | Wybiera firmę → sprawdza członkostwa i role → weryfikuje historię dostępu. | Dostęp ograniczony do aktualnych obowiązków. | Odczytać ustawienia i opisy ról; nie zapraszać użytkowników ani zmieniać uprawnień. |

## Plan pierwszej sesji interaktywnej — najwyżej 30 widoków

**wnioskowana — procedura proponowana:** jeden operator, jedna karta, działania sekwencyjne. Za widok liczyć także modal, nową zakładkę wewnątrz ekranu, zmianę filtra, ponowne otwarcie strony i wariant mobilny. Czynności wpisywania i kliknięcia oddzielać co najmniej 2 sekundami; nie używać równoległych zadań. Limit 2 prób logowania łącznie, bez automatycznych powtórzeń. Niepowodzenie nie uzasadnia resetowania liczników ani nowej sesji w celu obejścia limitu.

| Numery | Maksymalny budżet | Cel, tylko jeśli widoczny w rzeczywistym menu |
|---|---:|---|
| 1–3 | 3 | Ekran wejścia, wynik logowania i ewentualna druga próba. |
| 4–7 | 4 | Pulpit, nawigacja, wybór kontekstu i szczegóły projektu. |
| 8–12 | 5 | Zadania, szczegół, pojedynczy filtr, dostępne statusy, bezpieczny formularz. |
| 13–15 | 3 | Brygada, raport/czas, szczegół raportu. |
| 16–19 | 4 | Magazyn, pojedynczy ruch, zapotrzebowanie, dostawa. |
| 20–22 | 3 | Dokument/metadane, usterka, odbiór. |
| 23–25 | 3 | Koszty, ustawienia uprawnień, historia. |
| 26–30 | 5 | Mobilne: menu, lista zadań, szczegół, filtr, formularz bez zapisu. |

**wnioskowana:** rezerwacje budżetu przenosić wyłącznie na faktycznie odkryte moduły. Nie zgadywać URL-i ani nie odpytywać API w poszukiwaniu funkcji. Nie trzeba wykorzystać wszystkich 30 widoków. Plan nie gwarantuje kompletności dużej aplikacji.

**wnioskowana — reguły wykonania:**

- Kontrolować odpowiedzi przeglądarki bez utrwalania treści, nagłówków i sekretów. Przy dowolnym HTTP 429, 403 lub CAPTCHA przerwać automatyzację, opisać blokadę, bez obejścia i ponawiania.
- Nie klikać akcji oznaczania jako przeczytane, akceptacji, wysyłania, eksportu, resetowania, rezerwacji ani zmiany statusu. Odczyt też może mieć skutki uboczne; w razie niepewności pominąć funkcję.
- Nie wpisywać treści w formularze z możliwym autosave. Otwarcie kreatora tworzącego szkic na serwerze również jest zapisem i wymaga pominięcia.
- Użyć nietrwałego kontekstu; logowanie wyłącznie z env w pamięci. Wyłączyć trace, HAR, video, zapisywanie storage state, debug logi i zrzuty strony z danymi. W raportach tylko nazwy kontrolek, anonimowy opis zachowania i liczniki.
- Dla widoku rejestrować: numer, etykietę z UI bez danych osobowych, rolę bez tożsamości, desktop/mobile, pola/wymagalność, widoczne opcje statusów i filtrów, zależności, wynik oraz status dowodu. Sam przycisk potwierdza jego obecność, nie skuteczność operacji.

## Zapisy — bezpieczne testy do późniejszego zatwierdzenia

Wszystkie wyniki poniżej są **niezweryfikowane**. Testować dopiero w izolowanym środowisku z danymi syntetycznymi, po oddzielnym zatwierdzeniu zakresu i sprzątania; obecnie niczego nie wykonywano.

| Test | Minimalny przebieg | Kryterium wyniku |
|---|---|---|
| Zadanie | Utworzenie syntetycznego zadania, przypisanie, zgłoszenie wykonania, odbiór. | Poprawne przejścia i historia; odświeżenie zachowuje wynik. |
| Raport | Szkic → złożenie → odrzucenie z powodem → korekta → zatwierdzenie. | Rozdział uprawnień i widoczne wersje. |
| Magazyn | Przyjęcie, rezerwacja, częściowe wydanie i korekta sztucznego materiału. | Spójne jednostki, salda, historia i brak podwójnego wydania. |
| Plik | Wgranie nieszkodliwego pliku testowego i nowej rewizji. | Poprawne powiązanie z projektem i zachowanie poprzedniej wersji. |
| Uprawnienia | Przygotowane konta dwóch firm i przypisania projektowe. | Dozwolone operacje działają, konta nie widzą cudzych danych; bez enumeracji produkcji. |
| Konflikt/offline | Dwa testowe urządzenia zmieniają ten sam szkic, jedno wraca po utracie sieci. | Brak cichego nadpisania i duplikatów; jasna obsługa konfliktu. |

Powiązania: [UX](UX_REVIEW.md), [ulepszenia](IMPROVEMENTS.md), [architektura](ARCHITECTURE.md), [roadmapa](ROADMAP.md).
