# HERC — audyt funkcjonalny

Data: 2026-10-09. Referencja: https://herc-zarzadzanie-budowa.vercel.app/. Wersja wyświetlana w UI: 1.0.12, pilotażowa. Kontynuacja [PR #1](https://github.com/llit47/sitegrid/pull/1).

## Wynik i granice dowodów

**potwierdzona:** wykonano 30 widoków, w tym ponowne otwarcia, wyniki logowania, modal, jego zamknięcie i warianty mobilne; 2 próby logowania; konto o roli workspace `worker`. Zbadano 10 obszarów: Start, projekty/foldery, zadania, plany, czat, wpisy/historię, obecność, pulpit kierownika/raporty, kalendarz i magazyn oraz sekcję „Więcej”. Nie wykonano operacji zapisu danych biznesowych, eksportów, testów obciążeniowych ani bezpośredniego przeszukiwania API. Audyt obejmuje dostępny zakres jednego konta, nie wszystkie role i konfiguracje produktu.

- **potwierdzona** — bezpośrednia obserwacja UI/DOM lub wskazanego kodu klienta. Przycisk potwierdza dostępność kontrolki, nie skuteczność operacji.
- **wnioskowana** — interpretacja zastosowania, ryzyka albo rekomendacja własnej aplikacji.
- **niezweryfikowana** — zachowanie niewykonane lub obszar niedostępny w tej sesji. Nie oznacza braku funkcji.

**potwierdzona — metoda:** Chromium przez Playwright z `/home/codex/herc-audit-tools`, Node.js 24.21.0; jeden aktywny operator, akcje sekwencyjne z przerwą co najmniej 2,1 s. Desktop 1440×900, mobilny viewport 390×844. Odczyty DOM i geometrii, bez zapisu screenshotów, HAR, trace, video, storage state, treści rekordów i załączników. Nazwy i wartości rekordów redagowano w pamięci przed zasadniczymi odczytami UI; raport nie zawiera danych osobowych ani sekretów. Sesja i uwierzytelnienie wyłącznie w nietrwałym kontekście przeglądarki, zamkniętym na koniec. Nie przeprowadzono wizualnej oceny kolorów/kontrastu ani testu fizycznego telefonu.

## Diagnostyka i wpływ narzędzia na wynik

**potwierdzona:** obie zmienne `HERC_LOGIN` i `HERC_PASSWORD` były dostępne; ujawniono wyłącznie TRUE/FALSE. Wcześniejsze blokady środowiska opisane w pierwszym commicie PR są historyczne i już nie opisują obecnej sesji.

V01 to pierwsze wejście. Kanał procesu nie pozwalał kontynuować wejściem standardowym, dlatego przeglądarkę uruchomiono ponownie (V02, nadal bez próby logowania). Wyniki dwóch kliknięć logowania to V03–V04. Lokalna blokada żądań innych niż GET/HEAD/OPTIONS zakłóciła start aplikacji: łącznie przerwano dwa żądania; jedno z nich było odczytem uprawnień `herc_my_folder_capabilities` przesyłanym przez POST. Nie utrwalono szczegółów pierwszego przerwanego żądania, więc nie przypisujemy mu konkretnego endpointu. UI pokazywało „Błąd połączenia: TypeError: Failed to fetch”. **Nie jest to potwierdzona wada HERC.**

Po sprawdzeniu wywołania odczytu uprawnień w dostarczonym kodzie klienta dopuszczono ten konkretny RPC. Zwykłe odświeżenie V05 wykorzystało już istniejącą sesję i otworzyło aplikację; nie wykonywano trzeciej próby logowania. Uwierzytelnienie otrzymało wyjątek od blokady podczas logowania, pozostałe mutacje pozostały zablokowane. Nie znamy implementacji serwerowej RPC; jego odczytowe przeznaczenie wynika z kodu klienta i inicjalizacji uprawnień. Nie odnotowano HTTP 403/429 ani CAPTCHA w badanej aplikacji. Licznik przerwanych żądań pozostał równy 2 do zamknięcia sesji.

**potwierdzona:** formularze wydarzenia i przyjęcia otwarto po sprawdzeniu procedur otwierania w kodzie klienta: przygotowanie pól/modalu, osobna procedura zapisu. Nie wpisywano treści biznesowych, nie zmieniano statusów, filtrów zapisujących preferencje ani ustawień. Obecność ukrytych formularzy w DOM ekranu wejścia nie jest dowodem udostępnienia tych funkcji użytkownikowi.

## Rejestr wszystkich widoków — potwierdzona obserwacja

| Widok | Rozmiar / miejsce | Wynik i zakres |
|---|---|---|
| V01 | desktop, wejście | Formularz e-mail/hasło; odczyt DOM obejmował też ukryte sekcje — wyłączone z dowodów funkcjonalnych. |
| V02 | desktop, ponowne wejście | Widoczny ekran logowania; reset hasła nieuruchamiany. |
| V03–V04 | desktop, dwa wyniki logowania | Zakłócenie lokalną blokadą żądań; patrz diagnostyka. |
| V05 | desktop, odświeżenie / Start | Sesja działa, rola `worker`, statystyki i skróty; osobne oznaczenia lokalnego kalendarza i magazynu. |
| V06 | desktop, Projekty | Lista, „Otwórz”, „+ Dodaj”, opis „Możesz edytować”. |
| V07 | desktop, projekt | Foldery, lokalne liczniki poziomu, zakładki Przegląd/Zadania/Plany/Czat/Magazyn. |
| V08 | desktop, folder | Okruszki projektu/folderu, zadania na tym poziomie, pusty stan podfolderów. |
| V09 | desktop, Zadania folderu | Kolumny trzech statusów; checkboxy i selektory statusu. |
| V10 | desktop, Czat folderu | „Czat folderu wyłączony”; brak wysyłania. |
| V11 | desktop, „Wróć poziom wyżej” | Z folderu przejście do listy projektów, nie przeglądu projektu nadrzędnego. |
| V12 | desktop, ponowne otwarcie projektu | Powrót do przeglądu projektu. |
| V13 | desktop, Plany | Lista PDF, liczba pinezek i wymiarów, „Dodaj PDF”; bez otwierania treści plików. |
| V14 | desktop, globalne Zadania | Lista z kontekstem projektu/folderu i skrótem do niego; trzy statusy; brak widocznej wyszukiwarki/filtrów. |
| V15 | desktop, Wpis | Pole notatki, zapis, pusty stan ostatnich wpisów. |
| V16 | desktop, Historia | „Brak historii”. |
| V17 | desktop, Więcej | Organizacja budowy, kalendarz, magazyn; opis lokalności i kopii danych. |
| V18 | desktop, Lista obecności | Formularz czasu, lokalne sumy, pusty stan; eksport CSV tylko widoczny. |
| V19 | desktop, Pulpit kierownika | Projekt/dzień, bieżące zadania, pinezki, godziny, formularz raportu. |
| V20 | desktop, Kalendarz | Miesiąc i dzień, pusty stan, tryb lokalny. |
| V21 | desktop, Nowe wydarzenie | Modal z tytułem, datą, godzinami, projektem i opisem. |
| V22 | desktop, anulowanie wydarzenia | Powrót do kalendarza bez zapisu. |
| V23 | desktop, Więcej ponownie | Przejście do magazynu. |
| V24 | desktop, Magazyn | Puste materiały/ruchy; wyszukiwanie, filtr braków i akcje. |
| V25 | desktop, przyjęcie bez kodu | Pusty formularz nazwy, kodu, jednostki, progu i ilości. |
| V26 | mobile, ten sam modal | Brak poziomego overflow; pola z etykietami; część przycisków wysokości 37 px. |
| V27 | mobile, anulowanie / Magazyn | Powrót bez zapisu; układ mieści się w 390 px. |
| V28 | mobile, globalne Zadania | Karty mieszczą się w szerokości, selektory ok. 35 px, checkboxy 28×28 px. |
| V29 | mobile, Więcej | Brak poziomego overflow. |
| V30 | mobile, Lista obecności | Pola z etykietami, szerokość bez overflow; pola 44–49 px, zapis 37 px. |

Nieudane dopasowania selektorów w automatyzacji nie zmieniały widoku ani danych; nie traktujemy ich jako błędów nawigacji produktu. Po V30 zamknięto przeglądarkę.

## Mapa funkcji i użyteczności

Kolumna obserwacji jest **potwierdzona** w podanym zakresie; zastosowanie jest **wnioskowane**, a ostatnia kolumna **niezweryfikowana**.

| Moduł / dowód | Obserwacja | Zastosowanie na budowie | Granica weryfikacji |
|---|---|---|---|
| Dostęp i Start, V02–V05 | E-mail/hasło, reset i wylogowanie jako kontrolki; pulpit stanu projektów i trzech statusów zadań, skróty. | Kierownik: szybki przegląd; brygadzista/pracownik: wejście do pracy. | Reset, wygaśnięcie sesji, inne konta, izolacja firm. |
| Projekty/foldery, V06–V08 | Hierarchia folderów, okruszki, liczniki i zakładki; dostęp opisany jako możliwość edycji. | Podział budowy na zakresy lub lokalizacje robót. | Nie znamy formalnego znaczenia folderów, członkostw brygad ani reguł serwera. |
| Zadania, V09/V14/V28 | Do zrobienia/W trakcie/Zrobione, zmiana przez kontrolki, kontekst folderu. | Pracownik: zakres robót; brygadzista: stan prac; kierownik: przegląd wykonania. | Zapis, przydziały, terminy, zależności, odbiór oddzielony od wykonania. |
| Plany, V13 | Lista PDF, pinezki i wymiary jako liczniki, akcja dodania PDF. | Dokumentacja miejsca pracy i oznaczanie uwag. | Podgląd PDF, kalibracja, zdjęcia/głos, rewizje, skuteczność uploadu. |
| Czat, V10 | Zakładka istnieje, czat badanego folderu wyłączony. | Ustalenia w kontekście robót. | Wysyłanie, historia, powiadomienia i odczyt przez inne osoby. |
| Wpis/Historia, V15–V16 | Luźna notatka i osobna pusta Historia. | Szybkie zebranie spraw do uporządkowania. | Powiązanie notatki z zadaniem, synchronizacja, zakres i trwałość historii. |
| Obecność, V18/V30 | Lokalny formularz czasu i podsumowania; pracownik jako tekst; widoczny eksport CSV. | Brygadzista: robocze godziny ekipy; kierownik: lokalne zestawienie. | Obliczenia, korekty, zatwierdzanie, konta pracowników, eksport. |
| Pulpit/raporty, V19 | Bieżące zadania/pinezki, godziny dla dnia; opis wykonania i problemów; zapis/TXT jako kontrolki. | Kierownik: przekazanie stanu dnia; brygadzista: opis postępu i przeszkód. | Raport współdzielony, akceptacja, korekty i uprawnienia zapisu. |
| Kalendarz, V20–V22 | Miesiąc/dzień, formularz wydarzenia, lokalność; projekt opcjonalny. | Terminy robót, spotkania i dostawy jako wydarzenia. | Wspólny harmonogram, zależności robót, dostawy jako osobny proces. |
| Magazyn, V24–V27 | Szukanie nazwy/kodu, filtr „Do uzupełnienia”, ruchy, przyjęcie/wydatek/skan jako akcje, formularz jednostek. | Magazynier/brygadzista: robocza kontrola zapasów i wydań. | Stany na wielu urządzeniach, ruchy, rezerwacje, skaner i rozliczenie dostaw. |
| Więcej/kopie, V17/V29 | Jawny opis zakresu lokalnego i Supabase, kopia lokalna i przenoszenie danych. | Użytkownik: świadomość miejsca przechowywania i ręcznej kopii. | Skuteczność kopii i restore; narzędzia administracyjne innych ról. |

## Formularze — potwierdzony zakres odczytu

| Formularz | Pola i wymagalność widoczna w DOM | Czego nie sprawdzono |
|---|---|---|
| Logowanie | E-mail i hasło; kod klienta sprawdza obecność obu. | Reguły serwera, odzyskiwanie i blokada konta. |
| Szybki wpis | Jedno textarea, brak HTML `required`. | Reguły zapisu i powiązania. |
| Obecność | Projekt, pracownik, data, od/do i przerwa mają `required`; uwagi opcjonalne. | Przerwa większa od zmiany, zmiana przez północ, duplikaty. |
| Raport | Projekt, dzień, wykonanie, problemy/materiały; brak HTML `required`. | Minimalna treść, zatwierdzanie i wersje. |
| Wydarzenie | Tytuł, data, godziny, projekt, opis; brak HTML `required`; UI oznacza część pól jako opcjonalne. | Walidacja JS/serwera; brak `required` nie dowodzi braku walidacji. |
| Przyjęcie materiału | Nazwa, opcjonalny kod, sztuki/metry, próg, ilość; ilość ma `required`, przyciski +1/+5/+10. | Walidacja liczby i jednostek, rzeczywista zmiana salda. |

## Zależności i przepływy

**potwierdzona:** UI i kod inicjalizacji wskazują Supabase dla uwierzytelnienia oraz projektów/folderów/zadań; kod klienta odczytuje członkostwa workspace i uprawnienia folderów. To nie audyt bazy, polityk RLS ani całego backendu. Sekcja „Więcej” opisuje lokalność magazynu, PDF/pinezek, obecności i raportów z zastrzeżeniem jawnego trybu online. Obserwowane kalendarz i magazyn pokazują lokalny tryb. Nie badano synchronizacji dwóch urządzeń.

**potwierdzona w UI:** projekt → folder → zadania/plany/czat; lista globalna zadań → projekt/folder; obecność wybiera projekt; pulpit kierownika łączy projekt, dzień i lokalne godziny, a stan zadań jest bieżący, nie historyczny na wybraną datę. Wskaźnik niskich stanów jest opisany jako dotyczący magazynu całej firmy. Wydarzenie może dotyczyć projektu lub spraw ogólnych.

**wnioskowana ocena ról:** kierownik otrzymuje użyteczny przegląd robót, ale nie powinien na jego podstawie zakładać wspólności raportów i godzin. Brygadzista ma prosty zapis czasu i problemów, lecz centralne przekazanie danych wymaga weryfikacji/rozwoju. Pracownik ma odczyt zadań i zmianę statusu jako kontrolkę, ale w badanym widoku brak wyodrębnienia „mojej pracy”. Żadnego z pełnych procesów zapisu tych trzech ról nie ukończono. Dostęp kierownika, administratora i magazyniera nie był badany na osobnych kontach; nie utożsamiamy roli `worker` z całą macierzą uprawnień.

## Niepotwierdzone obszary i dalsze testy

**niezweryfikowana:** osobne moduły firm/brygad, zapotrzebowań i częściowych dostaw, kosztów, usterek/odbiorów, powiadomień, rewizji dokumentów, uprawnień administratora oraz pełne offline. Nie były widoczne jako osobne moduły w badanej nawigacji. Pinezka nie jest dowodem procesu odbioru; wydarzenie „dostawa” nie dowodzi obsługi zaopatrzenia; Historia nie dowodzi niezmiennego audytu.

**wnioskowana:** kolejne testy na izolowanych danych syntetycznych, poza zakresem tej sesji: pełny cykl zadania i odbioru, raport/korekta, przyjęcie–wydanie–korekta, wersje plików, dwie firmy i role, odwołanie dostępu, offline/konflikt i odtworzenie kopii. Każdy wymaga jawnego zakresu zapisów. Nie wykonywać ich na tej produkcji.

Powiązania: [UX](UX_REVIEW.md), [ulepszenia](IMPROVEMENTS.md), [architektura](ARCHITECTURE.md), [roadmapa](ROADMAP.md).
