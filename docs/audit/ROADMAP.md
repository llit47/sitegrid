# Roadmapa i podział na małe PR-y

Data: 2026-10-09. **wnioskowana:** proponowana kolejność prac nad własnym produktem; nie odtworzenie HERC. **potwierdzona:** obecna zmiana zawiera tylko dokumentację; nie uruchomiono usług ani implementacji aplikacji. Stan poznania referencji: [FUNCTIONALITY.md](FUNCTIONALITY.md).

## Pierwszy PR

**wnioskowana:** pierwszy PR powinien zawierać niniejsze pięć dokumentów pod tytułem „docs: przygotowanie audytu HERC i propozycja architektury self-hosted”. Opis musi wskazywać **0 zaobserwowanych modułów** i blokady środowiskowe. Nie nazywać go zakończonym audytem funkcjonalnym. Nie mergować automatycznie.

**wnioskowana:** pierwszy kolejny PR to uzupełnienie dowodów z legalnej sesji przeglądarkowej. Dopiero po nim i decyzji o MVP rozpoczynać kod. Fundamenty izolacji firm są rekomendowanym pierwszym pionowym fragmentem implementacji, zanim powstaną moduły robót i magazynu.

## Etap A — dowody i decyzje

Każdy wiersz poniższych tabel to **wnioskowana** propozycja. Numery PR-ów są numerami planu, nie istniejącymi numerami GitHuba.

| PR | Mały zakres | Zależność | Kryterium zakończenia |
|---|---|---|---|
| A01 | Obecne pięć dokumentów, rejestr dowodów i granic. | Brak | Spójne oznaczenia pewności, brak sekretów i przypisanych bez dowodu funkcji HERC. |
| A02 | Uzupełnienie audytu interaktywnego oraz UX desktop/mobile. | Env i przeglądarka; A01 | ≤30 widoków, ≤2 logowania, sekwencyjność i odstępy ≥2 s; dowód przy każdej obserwacji, luki jawne. |
| A03 | Słownik domeny, MVP, macierz ról i krótkie ADR-y dotyczące granic firm, offline, RPO/RTO. | A02 lub jawna decyzja budowy niezależnie od referencji | Uzgodnione procesy pięciu ról; zakres P0/P1 zatwierdzony, niewiadome zapisane. |

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
| B11 | Opis uruchomienia na VM, konfiguracja usług, kopia i odtworzenie w środowisku testowym. | B10; I04 | Odtworzona baza i pliki; zmierzony czas, udokumentowane ograniczenia. |

**wnioskowana:** B11 przygotowuje artefakty operacyjne i testową procedurę; uruchomienie na docelowym Proxmoxie wymaga osobnego zadania wdrożeniowego. Każdy moduł od chwili powstania używa sprawdzonych granic dostępu; nie odkładać ochrony danych na końcowy PR.

## Etap C — pionowy proces kierownik–brygada–pracownik

| PR | Mały zakres | Zależność / rekomendacja | Kryterium zakończenia |
|---|---|---|---|
| C01 | Zadania, przydziały, terminy i lista z filtrami. | B06–B08; I06 | Zakres projektu/brygady egzekwowany w API, brak cyklicznych zależności. |
| C02 | Przejścia statusów, blokady, zgłoszenie i odbiór. | C01; I06 | Pełny przebieg syntetycznego zadania z rozdzielonymi rolami. |
| C03 | Mobilna „moja praca”, szczegół i kontekst budowy. | C02; I05 | Sprawdzenie klawiaturą i na telefonie, powrót zachowuje filtry. |
| C04 | Szkic raportu dziennego i pozycji czasu. | C03; I07 | Walidacja czasu/jednostek i poprawne wiązanie z projektem. |
| C05 | Złożenie, zatwierdzanie i korekty raportu. | C04; I07 | Zatwierdzone dane nie zmieniają się bez historii i powodu. |
| C06 | Usterka z odpowiedzialnym i załącznikiem. | C02, B10; I11 | Usterka dostępna właściwemu projektowi, plik dziedziczy zakres. |
| C07 | Weryfikacja naprawy i ponowne otwarcie. | C06; I11 | Zachowana historia odbiorów i właściwe uprawnienia. |

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
