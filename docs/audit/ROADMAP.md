# Roadmapa i podział na małe PR-y

Data: 2026-10-09. **wnioskowana:** proponowana kolejność prac nad własnym produktem; nie odtworzenie HERC. **potwierdzona:** obecna zmiana zawiera tylko dokumentację; nie uruchomiono usług ani implementacji aplikacji. Docelowe środowisko: **LXC Debian 13 na Proxmoxie**. Stan poznania referencji: [FUNCTIONALITY.md](FUNCTIONALITY.md).

## Stan PR #1

**potwierdzona:** [PR #1](https://github.com/llit47/herc/pull/1), branch `docs/herc-functional-audit`, jest uzupełniany tymi pięcioma dokumentami. Audyt odczytowy osiągnął 30 widoków i 2 próby logowania; brak zapisów biznesowych. Dotychczasowe hipotezy zastąpiono obserwacjami tam, gdzie pojawiły się dowody; pozostałe luki są jawne. Nie implementowano aplikacji i nie wykonano wdrożenia.

**wnioskowana:** następny etap to decyzje domenowe/MVP i testy na danych syntetycznych. Nie potrzeba kolejnego PR tylko do powtarzania tego samego audytu odczytowego. Testy innych ról, zapisów, synchronizacji i kopii pozostają odrębnym zakresem. PR #1 nie jest automatycznie mergowany.

## Etap A — dowody i decyzje

A01–A02 opisują **potwierdzony** stan dokumentacji i sesji. Pozostałe wiersze to **wnioskowane** propozycje. Numery PR-ów są numerami planu, nie istniejącymi numerami GitHuba.

| PR | Mały zakres | Zależność | Kryterium zakończenia |
|---|---|---|---|
| A01 | Pięć dokumentów i granice — wykonane w PR #1. | Brak | Spójne oznaczenia pewności, brak sekretów i przypisanych bez dowodu funkcji HERC. |
| A02 | Odczytowy audyt i UX desktop/mobile — wykonane w PR #1. | A01 | 30 widoków, 2 próby logowania, odstępy ≥2 s; V01–V30, jawne ograniczenia roli i zapisów. |
| A03 | Słownik domeny, MVP, macierz ról i krótkie ADR-y dotyczące granic firm, offline, RPO/RTO. | A02; rozmowy z użytkownikami | Uzgodnione procesy pięciu ról; zakres P0/P1 zatwierdzony, niewiadome zapisane. |

## Etap B — fundamenty przed pilotażem

| PR | Mały zakres | Zależność / rekomendacja | Kryterium zakończenia |
|---|---|---|---|
| B01 | Szkielet React/TS, Fastify, kontrakty i CI, lokalna konfiguracja bez sekretów. | A03 | Powtarzalny build i jeden sprawdzony endpoint zdrowia; bez wdrożenia produkcji. |
| B02 | Migracje użytkowników, firm i członkostw; dwie syntetyczne firmy. | B01; I01 | Więzy i rollback/forward migracji sprawdzone lokalnie; żadnych danych referencyjnych. |
| B03 | Logowanie, sesje, wylogowanie i odwołanie sesji. | B02; I02 | Test cyklu sesji oraz blokady po dezaktywacji konta. |
| B04 | Kontekst firmy, polityki dostępu i RLS. | B03; I01 | Testy odmowy między firmami, także przy użyciu puli połączeń. |
| B05 | Projekty i członkostwa projektowe z podstawową listą w UI. | B04; I01 | Użytkownik widzi tylko przypisane projekty; brak możliwości dowiązania cudzej firmy. |
| B06 | Brygady i przypisania z datami obowiązywania. | B05; I01 | Historia składu i spójność zakresu projektu. |
| B07 | Wspólny zapis audytu i kontrola wersji na jednym zasobie. | B05; I03 | Zmiana i audyt atomowe; równoczesna edycja zgłasza konflikt. |
| B08 | Idempotencja komend i outbox na jednym zasobie. | B07; I03/I08 | Ponowienie nie dubluje skutków; retry workera nie gubi zdarzenia. |
| B09 | Metadane i upload/pobranie pliku z autoryzacją. | B04–B05; I10 | Plik innej firmy niedostępny, ograniczenia rozmiaru, obsługa przerwanego uploadu. |
| B10 | Rewizje i uzgadnianie plików po niedokończonej operacji. | B09; I10 | Nie ma widocznego „gotowego” dokumentu bez treści, stara rewizja zachowana. |
| B11 | Instrukcja nieuprzywilejowanego LXC Debian 13 na Proxmoxie; usługi systemd, wolumeny, kopia i odtworzenie testowe. | B10; I04 | Sprawdzony szablon i UID/GID, jawny zakres kopii rootfs/mount pointów; odtworzona baza i pliki w nowym LXC, zmierzony czas. |

**wnioskowana:** B11 przygotowuje artefakty operacyjne i testową procedurę; uruchomienie na docelowym Proxmoxie wymaga osobnego zadania wdrożeniowego. Każdy moduł od chwili powstania używa sprawdzonych granic dostępu; nie odkładać ochrony danych na końcowy PR.

## Etap C — pionowy proces kierownik–brygada–pracownik

| PR | Mały zakres | Zależność / rekomendacja | Kryterium zakończenia |
|---|---|---|---|
| C01 | Lokalizacje/foldery, zadania, przydziały, terminy i lista z filtrami. | B06–B08; I06 | Zakres projektu/brygady egzekwowany w API, brak cyklicznych zależności. |
| C02 | Przejścia statusów, blokady, zgłoszenie i odbiór. | C01; I06 | Pełny przebieg syntetycznego zadania z rozdzielonymi rolami. |
| C03 | Mobilna „moja praca”, szczegół i kontekst budowy. | C02; I05 | Sprawdzenie klawiaturą i na telefonie; powrót do rodzica zachowuje filtry, liczniki jawnie odróżniają folder od projektu (UX-002–UX-005). |
| C04 | Szkic raportu dziennego i pozycji czasu. | C03; I07 | Walidacja czasu/jednostek i poprawne wiązanie z projektem. |
| C05 | Złożenie, zatwierdzanie i korekty raportu. | C04; I07 | Zatwierdzone dane i snapshot podsumowania nie zmieniają się bez historii i powodu; dwa urządzenia widzą ten sam raport (V19). |
| C06 | Usterka z odpowiedzialnym i załącznikiem. | C02, B10; I11 | Usterka dostępna właściwemu projektowi, plik dziedziczy zakres. |
| C07 | Weryfikacja naprawy i ponowne otwarcie. | C06; I11 | Zachowana historia odbiorów i właściwe uprawnienia. |
| C08 | Wspólny kalendarz firmy/projektu, terminy i strefa czasu. | B05–B08; I15 | Termin widoczny na dwóch uprawnionych kontach; brak dostępu spoza projektu; tryb synchronizacji jawny (V20). |

## Etap D — niezawodna praca terenowa

| PR | Mały zakres | Zależność / rekomendacja | Kryterium zakończenia |
|---|---|---|---|
| D01 | Powłoka PWA i jawny tryb offline; cache minimalnego zakresu. | C03; I08 | Brak danych poprzedniego konta po wylogowaniu; wskazanie aktualności. |
| D02 | Szkice lokalne i kolejka jednej komendy raportu. | D01, C04, B08; I08 | Utrata sieci nie usuwa szkicu; ponowienie nie tworzy drugiego raportu. |
| D03 | Snapshot i strumień zmian z kursorem i tombstones. | D02; I08 | Brak pominięć przy kolejności commitów; poprawny reset wygasłego kursora. |
| D04 | UI konfliktu, utrata uprawnień i wznowienie synchronizacji. | D03; I08 | Brak cichego nadpisania, widoczna odmowa i oczyszczenie nieuprawnionego cache po połączeniu. |
| D05 | Kolejka zdjęć i test rzeczywistego telefonu na danych syntetycznych. | D04, B10; I08 | Retry uploadu nie dubluje załącznika; użytkownik zna stan wysyłki. |

## Etap E — magazyn i zaopatrzenie

| PR | Mały zakres | Zależność / rekomendacja | Kryterium zakończenia |
|---|---|---|---|
| E01 | Materiały, jednostki, magazyny i dostęp. | B04–B08; I09 | Spójność jednostek, zakres magazyniera niezależny od administracji firmy. |
| E02 | Niezmienny rejestr przyjęć/wydań i korekt. | E01; I09 | Uzgadnialne salda, test konkurencyjnego wydania. |
| E03 | Rezerwacje i powiązanie zużycia z projektem. | E02; I09 | Rezerwacja nie dubluje wydania ani dostępnego zapasu. |
| E04 | Zapotrzebowania i częściowe dostawy. | E03; I09 | Pozostała ilość wynika z realizacji; anulowanie nie usuwa ruchów. |

## Etap F — pilotaż i rozszerzenia

**wnioskowana:** najpierw ograniczony pilotaż po B11 i C03, jeśli zapewniona praca online; raportowanie po C05, teren offline po D05, magazyn po E04. Przed każdą bramką potwierdzić uprawnienia, backup, ergonomię i integralność danych dla udostępnianego zakresu. Testy wykonuje się na własnych danych syntetycznych, nie na produkcyjnym HERC.

| PR | Mały zakres | Zależność | Kryterium zakończenia |
|---|---|---|---|
| F01 | Monitoring, alert kopii/dysku i instrukcja reakcji. | B11; przed pilotażem | Kontrolowana awaria testowa widoczna operatorowi, bez sekretów w logach. |
| F02 | Wnioski z pilotażu pięciu ról i poprawki o najwyższym wpływie. | Odpowiednie bramki C–E | Udokumentowane wyniki zadań użytkowników i poprawione rzeczywiste blokady. |
| F03+ | Oddzielne PR-y: przypomnienia, raport kosztów, eksport. | Stabilne dane C–E; P2 | Każda funkcja ma konkretną potrzebę, właściciela i kryterium odbioru. |
| F04+ | Osobne ADR-y i eksperymenty dla QR, integracji, aplikacji natywnej. | Potwierdzona potrzeba; P2 | Nie rozszerza zakresu MVP bez uzasadnienia. |

## Reguły małego PR-a i zakończenia

**wnioskowana:** jeden PR realizuje jedną decyzję lub możliwy do oceny fragment zachowania; zwykle 1–3 dni, a większy zakres dzielony przed implementacją. Każdy opisuje zmianę, zależności, sposób sprawdzenia, migrację i ryzyko. Testy koncentrują się na uprawnieniach, integralności i zachowaniu użytkownika; same zmiany dokumentacji wymagają sprawdzenia spójności, linków i braku danych wrażliwych. Żaden etap nie obejmuje kopiowania kodu, materiałów ani identyfikacji wizualnej HERC.

**niezweryfikowana:** harmonogram kalendarzowy i ostateczny koszt — wymagają wyników A02/A03, składu zespołu i ograniczeń środowiska. Plan PR-ów nie jest deklaracją, że funkcje występują w referencji.
