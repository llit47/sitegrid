# HERC — ocena UX i luki dowodowe

Data: 2026-10-09. Oznaczenia i dowody E01–E05: [FUNCTIONALITY.md](FUNCTIONALITY.md).

## Wynik oceny

**potwierdzona:** nie oglądano interfejsu desktopowego ani mobilnego. Nie ma podstaw do oceny punktowej, diagnozy niespójności ani stwierdzenia, że HERC nie ma określonej funkcji. Poniższe ryzyka są warunkowe; nie są wykrytymi błędami aplikacji.

## Pięć największych problemów obecnego audytu

| ID | Status | Problem | Wpływ i następny krok |
|---|---|---|---|
| B01 | potwierdzona | Brak dostępnych danych logowania w wymaganych env (E01). | Nie można zbadać części uwierzytelnionej; udostępnić env bez ujawniania wartości. |
| B02 | potwierdzona | Brak dostępnej przeglądarki/Playwrighta (E02). | Nie można obserwować interakcji; udostępnić działające narzędzie. |
| B03 | niezweryfikowana | Nieznany zakres modułów i formularzy. | Nie można potwierdzić kompletności mapy ani szacować zgodności z HERC. |
| B04 | niezweryfikowana | Nieznane uprawnienia i przebiegi pięciu ról. | Nie wiadomo, czy aplikacja wspiera podział odpowiedzialności na budowie. |
| B05 | niezweryfikowana | Nieznana ergonomia mobilna, zachowanie przy utracie sieci i równoczesnej pracy. | Nie można ocenić przydatności w terenie. |

**potwierdzona:** to pięć ograniczeń oceny, nie pięć potwierdzonych wad HERC. Liczba potwierdzonych problemów produktowych: 0 przy pokryciu audytu 0; nie jest to dowód dobrej jakości.

## Kryteria kolejnej oceny

Każdy wiersz: stan HERC **niezweryfikowana**, zalecane kryterium **wnioskowana**. Ocena powinna opierać się na ukończeniu zadania i zrozumieniu wyniku przez użytkownika, nie na podobieństwie do aplikacji referencyjnej.

| Obszar | Desktop — co sprawdzić | Telefon — co sprawdzić | Kryterium akceptacji własnego produktu |
|---|---|---|---|
| Kontekst | Widoczna firma i projekt, zachowanie po przejściu do szczegółu. | Kontekst dostępny także przy zwiniętym menu. | Użytkownik rozpoznaje, na której budowie pracuje; zmiana projektu nie przenosi szkicu do innego projektu. |
| Nawigacja | Nazwy sekcji, powrót do listy, aktywna pozycja, link do szczegółu. | Menu obsługiwane jedną ręką, brak zasłoniętych działań. | Powrót zachowuje filtr i pozycję; podstawowa praca bez szukania w wielu modułach. |
| Listy | Kolumny, sortowanie, filtry, paginacja i puste wyniki. | Czytelne karty zamiast szerokiej tabeli jako jedynego widoku. | Widoczny aktywny filtr i sposób jego wyczyszczenia; odróżnienie pustego zbioru od błędu. |
| Formularze | Etykiety, jednostki, wymagane pola, walidacja, anulowanie. | Klawiatura właściwa dla typu pola; przyciski dostępne nad klawiaturą. | Błąd przypisany do pola, zachowanie wpisanej treści, jednoznaczny wynik zapisu. |
| Statusy | Rozdzielenie etapu pracy, priorytetu i blokady. | Tekst/ikona oprócz koloru, czytelność na zewnątrz. | „Zgłoszone jako wykonane” odróżnione od „odebrane”; widać osobę odpowiedzialną. |
| Informacja zwrotna | Wczytywanie, błąd, konflikt wersji, brak uprawnień. | Słaba sieć, retry, stan kolejki i czas aktualności. | Brak komunikatu „zapisano”, zanim serwer potwierdzi zapis; szkic lokalny opisany osobno. |
| Dokumenty | Rewizja, projekt, autor zmiany, powiązanie z robotą. | Czytelny podgląd, rozmiar przed pobraniem. | Jasne ostrzeżenie o starej rewizji; ograniczony dostęp zgodny z projektem. |
| Dostępność | Klawiatura, fokus, etykiety czytnika, zoom. | Szerokości 360–430 px, obrót i powiększenie tekstu. | Proponowany cel: WCAG 2.2 AA, elementy dotykowe projektowane na 44×44 CSS px; wymaga osobnej walidacji. |

**wnioskowana:** w sesji do 30 widoków użyć np. 1440×900 i 390×844; to reprezentatywne punkty, nie dowód zgodności wszystkich urządzeń. Emulacja nie potwierdza wygody dotyku, pracy w rękawicach, aparatu ani zachowania systemu podczas pracy w tle. Późniejszy test terenowy powinien obejmować rzeczywisty telefon i syntetyczny projekt.

## Ryzyka projektowe, których nie należy bezrefleksyjnie kopiować

Poniższe obserwacje są **wnioskowane** i warunkowe. Ich występowanie w HERC jest **niezweryfikowane**.

| Hipoteza ryzyka | Konsekwencja na budowie | Lepsze rozwiązanie i koszt kompromisu |
|---|---|---|
| Jeden rozbudowany pulpit dla wszystkich ról. | Pracownik szuka pojedynczego zadania wśród zestawień kierownika. | Widok „moja praca” i oddzielne zestawienia; więcej wariantów do utrzymania. |
| Swobodna zmiana dowolnego statusu. | Zadanie wygląda na odebrane bez kontroli jakości. | Jawne przejścia i role odbioru; dodatkowy krok tylko przy odbiorze. |
| Ręcznie edytowane saldo magazynu. | Brak wyjaśnienia zużycia i korekt. | Rejestr ruchów i korekty odwracające; trudniejszy model danych. |
| Automatyczne nadpisanie równoczesnej edycji. | Znika raport drugiej osoby. | Wersjonowanie i ekran konfliktu; wymaga obsługi wyjątków. |
| Kopia UI desktopowego na telefonie. | Małe kontrolki, długie formularze, przypadkowe operacje. | Krótkie formularze zadaniowe i widoki mobilne; dodatkowe testy. |

## Sposób uzupełniania raportu

**wnioskowana:** każdemu rzeczywistemu problemowi nadać identyfikator UX-NNN, status dowodu, numer widoku, rolę, urządzenie, kroki bez danych osobowych, wynik, wpływ i priorytet. Problem krytyczny blokuje pracę lub grozi utratą danych; wysoki powtarzalnie utrudnia podstawowe zadanie; niski dotyczy usprawnienia. Priorytet wdrożenia ustalać po potwierdzeniu wpływu, bez wymyślania częstotliwości zdarzeń.

**niezweryfikowana:** walidacja zapisów, autosave, rzeczywiste wygaśnięcie sesji, równoczesna edycja i offline wymagają osobnych testów syntetycznych z [FUNCTIONALITY.md](FUNCTIONALITY.md). Nie badać ich na rzeczywistych rekordach.
