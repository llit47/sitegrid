# Workspace UX (PR18)

> **PR21 — bieżący kod:** Pulpit i nawigacja stosują [nowy kontrakt backlogu i dostępu do zadań](TASK_BACKLOG.md). Poniżej zachowano historyczny opis wcześniejszego etapu; w konflikcie stosuj PR21.

> **Nowy kontrakt produktu 2026-10-11 — docelowy UX, niewdrożony w v0.1.1:** [Zarządzanie zadaniami v2](TASK_MANAGEMENT_V2.md). Pulpit ma pokazywać rzeczywiste, autoryzowane zadania: administrator/kierownik/brygadzista — zadania całej firmy z backlogiem i filtrami; pracownik — wyłącznie własne. Osobna zakładka „Zadania”, szybkie tworzenie bez wymaganego wykonawcy i przypisywanie z listy należą do PR21. Podzadania (PR22), komentarze/zdjęcia (PR23) następują osobno; planów PDF na razie nie realizujemy. Poniższa specyfikacja PR18 jest **historycznym opisem interfejsu v0.1.1**; jej „brak globalnych zadań” i powitalny pulpit nie są docelowym UX. W czasie implementacji zachować ochronę szkiców, niestabilnych komend M08, izolację firmy i PWA.


Nawigacja działa w pamięci zakładki na istniejącej trasie `/`. Nie dodaje routera, tras serwera ani zmian do allowlist PWA. Aktywacja zaproszeń nadal używa `/invitations/accept`.

Desktop ma stałą nawigację boczną, nagłówek firmy/konta i osobną treść. Tablet i telefon używają rozwijanego menu z etykietą, `aria-expanded`, obsługą Escape i powrotem fokusu. Zmiana sekcji przenosi fokus na jej tytuł. Jeden kompaktowy wybór firmy zastępuje listę przycisków firm. Jedno członkostwo wybiera firmę automatycznie; wiele wymaga wyboru w tej zakładce.

Pulpit i Projekty są dostępne w wybranej firmie. Kontrahenci, Pracownicy, Zaproszenia i Ustawienia firmy wymagają roli administratora firmy. Administracja platformy jest osobna; administrator bez członkostwa zaczyna w niej i nie pobiera projektów. Backend nadal rozstrzyga wszystkie uprawnienia do projektów, przydziałów i zadań.

Pulpit pokazuje branding i podsumowanie tej samej autoryzowanej listy projektów, którą wykorzystuje sekcja Projekty. Nie pobiera statystyk ani globalnych zadań. Projekty i ekran kontrahentów współdzielą istniejący hook katalogu, z niezmienionym zakresem administratora. Filtr pracownika pochodzi wyłącznie z jego widocznych projektów.

Formularze projektu i zadania otwierają się na żądanie. Szczegóły, członkowie, zadania i przygotowanie offline są osobnymi częściami projektu. Ekran pracowników rozróżnia członkostwo z kontem i profil bez konta oraz wskazuje zaproszenie i przydział jako warunki dostępu.

Odwiedzone sekcje pozostają zamontowane, lecz są ukryte atrybutem `hidden`. Przechowują formularze, wybrany File, wersje i M08 operationId wyłącznie w pamięci. Przełączenie firmy, wylogowanie, przejście do lokalnego odczytu i odświeżenie formularzy wymagają jawnego potwierdzenia odrzucenia szkicu. Oczekujący zapis lub niejednoznaczna komenda M08 blokują działania, które zniszczyłyby ich stan; należy poczekać lub ponowić tę samą operację. `beforeunload` ostrzega przed zamknięciem karty. Potwierdzona utrata dostępu i zmiana konta z innej karty nadal natychmiast czyszczą kontekst zgodnie z istniejącym mechanizmem bezpieczeństwa. Nie ma zapisu szkiców ani kolejki komend offline.

Stan PWA jest skrócony do paska. Informacje o braku połączenia, niedostępnej pamięci/powłoce, aktualizacji i lokalnym odczycie pozostają widoczne. Instrukcje instalacji są rozwijane. IndexedDB v2, przygotowanie snapshotów, limit 24 godzin, viewer tylko do odczytu, invalidacja konta, lifecycle i cache statyczny pozostają bez zmian.

Weryfikacja: `npm run check`, sześć dotychczasowych zestawów Playwright oraz `tests/workspace-browser.mjs`. Nowy zestaw sprawdza 1280/768/390 px, brak overflow, klawiaturę/fokus, role, jeden/wiele kontekstów, jeden request katalogu oraz szkice projektu/zadania/brandingu i anulowane zmiany firmy/wylogowanie. M08 sprawdza zachowanie komendy podczas nawigacji i blokadę odświeżenia po utracie odpowiedzi. Zestawy PWA/M10 nadal sprawdzają offline, aktywację zaproszeń i revokację. Screenshoty danych syntetycznych zapisuje `/tmp/sitegrid-pr18-visuals/`.

Ograniczenia: dane pulpitu odświeża się przez projekty lub ponowne sprawdzenie dostępu; nie ma agregacji ani odpytywania w tle. Szkice są zachowywane podczas nawigacji sekcji w bieżącej karcie, nie po restarcie lub wymuszonym unieważnieniu konta. Tabele administracji i zaproszeń mogą przewijać się wewnątrz własnego kontenera na telefonie. Schemat SQL pozostaje 11, wersje package/release pozostają bez zmian.
