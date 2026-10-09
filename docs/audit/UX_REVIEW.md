# HERC — ocena UX z sesji odczytowej

Data: 2026-10-09. Dowody V01–V30 i metoda: [FUNCTIONALITY.md](FUNCTIONALITY.md). Jedno konto `worker`, desktop 1440×900 i mobilny viewport 390×844. To ocena struktury, treści, nawigacji i geometrii DOM; bez pełnego audytu dostępności i testów zapisów.

## Najważniejsze ustalenia

**potwierdzona:** aplikacja ma spójny dolny pasek Start/Zadania/Wpis/Historia/Więcej, okruszki projektu/folderu, tekstowe statusy i zrozumiałe puste stany. Lokalność obecności, raportów, magazynu i kalendarza jest wyjaśniona w treści. Widoczne formularze mają krótkie zakresy; obecność i przyjęcie mają programowo powiązane etykiety sprawdzonych pól. Badane mobilne widoki nie mają poziomego overflow (`scrollWidth = innerWidth = 390`).

**wnioskowana:** aplikacja nadaje się jako prosty pulpit i lokalny notes operacyjny. Przydatność jako wspólny system rozliczania ekipy ogranicza rozdzielenie danych online i lokalnych oraz niepotwierdzony obieg odbiorów. Nie nadajemy oceny liczbowej, ponieważ nie wykonano pełnych zadań użytkowników.

## Pięć najważniejszych problemów / ryzyk

Fakty w kolumnie obserwacji są **potwierdzone**; wpływ, priorytet i zalecenie są **wnioskowane**. Priorytety dotyczą własnego produktu, nie zgłoszeń błędów do właściciela HERC.

| ID / priorytet | Obserwacja i odtworzenie | Wpływ na role | Zalecenie |
|---|---|---|---|
| UX-001 / wysoki | V17–V20/V24: nagłówek „online” współistnieje z lokalnymi raportami, godzinami, kalendarzem i magazynem; treść ostrzeżeń potwierdza ten podział. | Kierownik i brygadzista mogą oczekiwać wspólnych danych. To ograniczenie konfiguracji, nie dowód utraty danych. | Status synchronizacji przy konkretnym module/rekordzie; wspólna baza, lokalnie wyłącznie jawne szkice. |
| UX-002 / średni | V08→V10→V11: projekt → folder → Czat → „Wróć poziom wyżej” przenosi do listy projektów. | Wszystkie role tracą kontekst i muszą otworzyć projekt ponownie. Potwierdzone dla tej jednej ścieżki. | Powrót do rodzica zgodny z etykietą i zachowanie zakładki; test folderu zagnieżdżonego. |
| UX-003 / średni | V05/V07/V08/V19: zadania istnieją w podfolderach, ale nagłówek projektu podaje zero; w przeglądzie napis „Realizacja w tym miejscu”. | Kierownik może pomylić licznik bieżącego folderu z sumą całej budowy. Pulpit kierownika pokazuje sumę projektu. | Osobne, jednoznaczne „w tym folderze” / „cały projekt”, także przy liczniku nagłówka. |
| UX-004 / średni | V14/V28: globalna lista wszystkich zadań bez widocznych filtrów i wyszukiwarki; karty zawierają kontekst i status. | Pracownik szuka własnego zakresu na długiej liście, brygadzista nie zawęża widoku do ekipy. Nie dowodzi braku filtrów w innych ścieżkach. | „Moja praca”, projekt, wykonawca, status i wyszukiwanie; zachowanie filtrów przy powrocie. |
| UX-005 / średni | V26–V30: status zadania ok. 35 px, checkbox 28×28 px, część przycisków 37 px; dolna nawigacja ok. 50 px. | Mniejsze cele mogą utrudniać dotyk na budowie; wpływ w rękawicach niebadany. | Docelowo 44×44 CSS px dla podstawowych akcji, sprawdzenie fizycznym telefonem. To cel ergonomiczny, nie automatyczna diagnoza naruszenia WCAG. |

## Formularze i informacja zwrotna

**potwierdzona:** V18/V30 zawiera typy date/time/number, obowiązkowe pola i opcjonalne uwagi. V25/V26 ma duże pole ilości (ok. 62 px na mobilnym viewport), jednostkę i skróty zwiększenia ilości; V21 ma jawne anulowanie. Anulowanie obu modalnych formularzy wraca do poprzedniego modułu. Brak HTML `required` w części formularzy nie dowodzi braku walidacji JS.

**niezweryfikowana:** komunikaty błędów zapisów, utrzymanie danych po błędzie, autosave podczas pisania, konflikty, potwierdzenie po zapisie, przejścia klawiaturą/czytnikiem, fokus modalu, kontrast, zoom, klawiatura ekranowa i praca bez sieci. Formularzy nie wypełniano. Początkowy „Failed to fetch” był związany z lokalną blokadą audytora i nie jest problemem produktowym w tym raporcie.

## Ocena według roli

| Rola | Potwierdzona podstawa | Wnioskowana korzyść | Granica / niezweryfikowana |
|---|---|---|---|
| Kierownik | Pulpit łączy zadania, pinezki, godziny i opis dnia (V19). | Przegląd postępu i przeszkód w jednym miejscu. | Nie jest historycznym stanem robót dla wybranej daty; brak potwierdzenia wspólnych raportów, kosztów i odbiorów. |
| Brygadzista | Obecność i formularz raportu; kontekst folderów (V08/V18/V19). | Prosty zapis godzin i zakresu prac. | Brak osobnego konta brygadzisty; członkostwo brygad, akceptacja i przekazanie danych niebadane. |
| Pracownik | Konto `worker`, lista zadań, statusy i przejście do folderu (V14/V28). | Czytelny zakres oraz miejsce pracy. | Kontrolka zmiany statusu nie dowodzi skutecznego zapisu ani prawa do odbioru. Brak widocznej „mojej pracy”. |
| Magazynier | Lokalne stany i akcje magazynu (V24–V27). | Szybka obsługa przyjęcia na jednym urządzeniu. | Brak danych testowych i konta tej roli; synchronizacja, skan i salda nieweryfikowane. |
| Administrator | UI opisuje granice kopii lokalnej (V17). | Świadomość potrzeby oddzielnej ochrony danych serwera. | Zarządzanie kontami/rolami i odtwarzanie niedostępne w zakresie badania. |

## Dalsza walidacja własnego produktu — wnioskowana

Test użytkowy na sztucznej budowie: kierownik znajduje blokadę i odpowiedzialnego; brygadzista przekazuje godziny i raport; pracownik odnajduje przypisane zadanie i dokument. Mierzyć ukończenie i pomyłki, nie podobieństwo wyglądu do HERC. Osobno sprawdzić odczyt i dotyk na prawdziwym telefonie, odzyskanie szkicu po utracie sieci, odrzucenie zapisu bez uprawnień oraz spójność powrotów i filtrów.
