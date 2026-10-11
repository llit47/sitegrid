# Workspace UX (PR25)

Pulpit i Zadania są osobnymi ekranami. Pulpit pokazuje pełne liczniki zadań i podzadań aktywnych projektów oraz do 8 pozycji wymagających uwagi. `/api/organizations/:id/task-summary` agreguje dane w jednym zapytaniu z istniejącym runtime RLS: administrator/kierownik/brygadzista widzą zakres firmy, pracownik własne zadania. Liczniki nie zależą od paginacji listy. Zadania zachowują filtry, tworzenie, przydziały, dyskusje i podzadania.

Aktywny widok odpytuje autoryzowane dane co 15 sekund, wyłącznie online i w widocznej karcie. Powrót do karty, sekcji lub sieci odświeża dane natychmiast. Odświeżenie zachowuje zamontowane karty, rozwinięcia, formularze, zdjęcia i szkice dyskusji; odpowiedzi nie zastępują nowszej wersji. Jedno zapytanie danego zasobu może być w toku; zmiana zakresu anuluje poprzednie. Podczas zapisu lub niejednoznacznego wyniku M08 polling trwa, ale zastąpienie danych czeka na rozstrzygnięcie operacji. Pobrane strony listy są ponownie odczytywane; jawna zmiana filtrów/zapis resetuje paginację. Otwarta karta wypadająca poza filtr/stronę jest ponownie autoryzowana i zachowana z oznaczeniem, aby nie utracić szkicu. Ochrona dostępu ma pierwszeństwo przed zachowaniem stanu.

Kompaktowe karty mają statusy **Backlog**, **Do zrobienia**, **W toku**, **Do odbioru** i przyciski co najmniej 44 px. Techniczna wersja pozostaje w API, kontroli współbieżności i historii postępu. Motyw automatycznie śledzi `prefers-color-scheme`, również po zmianie ustawień systemowych; wspólna paleta obejmuje nawigację, pulpit, zadania, formularze, dialogi, dyskusje, zdjęcia i PWA.

PWA pokazuje mały wskaźnik Online/Offline oraz rozwijane instrukcje instalacji i istotne ostrzeżenia. Utrata sieci automatycznie otwiera istniejący viewer tylko do odczytu i ukrywa interfejs online, zachowując go w pamięci. Powrót online ponownie weryfikuje sesję. Nie ma ręcznego przełącznika ani zapisu offline. Szkice nie przetrwają przeładowania, restartu lub unieważnienia konta.

Walidacja: `npm run check`, `tests/task-summary.test.ts`, `tests/ux-refresh-browser.mjs` oraz istniejące regresje zadań, podzadań, M08, dyskusji, workspace, PWA i snapshotów. Nowy test sprawdza dwa konta, interwał, widoczność, reconnect, opóźnione odpowiedzi, szkice/zdjęcia, systemowy motyw i kontrast oraz 1280/768/390 px. Screenshoty syntetycznych danych: `/tmp/sitegrid-pr25-visuals/`. Bez migracji, nowych zależności i zmiany kontraktu wydania.

## Historyczny opis PR18

Poniżej zachowano opis wcześniejszego UX; bieżące zachowanie definiuje PR25 powyżej.

Nawigacja działa w pamięci zakładki na istniejącej trasie `/`. Nie dodaje routera, tras serwera ani zmian do allowlist PWA. Aktywacja zaproszeń nadal używa `/invitations/accept`.

Desktop ma stałą nawigację boczną, nagłówek firmy/konta i osobną treść. Tablet i telefon używają rozwijanego menu z etykietą, `aria-expanded`, obsługą Escape i powrotem fokusu. Zmiana sekcji przenosi fokus na jej tytuł. Jeden kompaktowy wybór firmy zastępuje listę przycisków firm. Jedno członkostwo wybiera firmę automatycznie; wiele wymaga wyboru w tej zakładce.

Pulpit i Projekty są dostępne w wybranej firmie. Kontrahenci, Pracownicy, Zaproszenia i Ustawienia firmy wymagają roli administratora firmy. Administracja platformy jest osobna; administrator bez członkostwa zaczyna w niej i nie pobiera projektów. Backend nadal rozstrzyga wszystkie uprawnienia do projektów, przydziałów i zadań.

Pulpit pokazuje branding i podsumowanie tej samej autoryzowanej listy projektów, którą wykorzystuje sekcja Projekty. Nie pobiera statystyk ani globalnych zadań. Projekty i ekran kontrahentów współdzielą istniejący hook katalogu, z niezmienionym zakresem administratora. Filtr pracownika pochodzi wyłącznie z jego widocznych projektów.

Formularze projektu i zadania otwierają się na żądanie. Szczegóły, członkowie, zadania i przygotowanie offline są osobnymi częściami projektu. Ekran pracowników rozróżnia członkostwo z kontem i profil bez konta oraz wskazuje zaproszenie i przydział jako warunki dostępu.

Odwiedzone sekcje pozostają zamontowane, lecz są ukryte atrybutem `hidden`. Przechowują formularze, wybrany File, wersje i M08 operationId wyłącznie w pamięci. Przełączenie firmy, wylogowanie, przejście do lokalnego odczytu i odświeżenie formularzy wymagają jawnego potwierdzenia odrzucenia szkicu. Oczekujący zapis lub niejednoznaczna komenda M08 blokują działania, które zniszczyłyby ich stan; należy poczekać lub ponowić tę samą operację. `beforeunload` ostrzega przed zamknięciem karty. Potwierdzona utrata dostępu i zmiana konta z innej karty nadal natychmiast czyszczą kontekst zgodnie z istniejącym mechanizmem bezpieczeństwa. Nie ma zapisu szkiców ani kolejki komend offline.

Stan PWA jest skrócony do paska. Informacje o braku połączenia, niedostępnej pamięci/powłoce, aktualizacji i lokalnym odczycie pozostają widoczne. Instrukcje instalacji są rozwijane. IndexedDB v2, przygotowanie snapshotów, limit 24 godzin, viewer tylko do odczytu, invalidacja konta, lifecycle i cache statyczny pozostają bez zmian.

Weryfikacja: `npm run check`, sześć dotychczasowych zestawów Playwright oraz `tests/workspace-browser.mjs`. Nowy zestaw sprawdza 1280/768/390 px, brak overflow, klawiaturę/fokus, role, jeden/wiele kontekstów, jeden request katalogu oraz szkice projektu/zadania/brandingu i anulowane zmiany firmy/wylogowanie. M08 sprawdza zachowanie komendy podczas nawigacji i blokadę odświeżenia po utracie odpowiedzi. Zestawy PWA/M10 nadal sprawdzają offline, aktywację zaproszeń i revokację. Screenshoty danych syntetycznych zapisuje `/tmp/sitegrid-pr18-visuals/`.

Ograniczenia: dane pulpitu odświeża się przez projekty lub ponowne sprawdzenie dostępu; nie ma agregacji ani odpytywania w tle. Szkice są zachowywane podczas nawigacji sekcji w bieżącej karcie, nie po restarcie lub wymuszonym unieważnieniu konta. Tabele administracji i zaproszeń mogą przewijać się wewnątrz własnego kontenera na telefonie. Schemat SQL pozostaje 11, wersje package/release pozostają bez zmian.
