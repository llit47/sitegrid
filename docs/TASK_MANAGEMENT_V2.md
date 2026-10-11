# SiteGrid — zarządzanie zadaniami v2 (decyzja produktowa, 2026-10-11)

**Status: PR21–PR23 są scalone na main; przygotowanie v0.1.3 obejmuje backlog, podzadania, komentarze/zdjęcia online i backup DB+files (schema14). Wydane v0.1.2 obejmuje PR22, bez PR23.** [Kontrakt implementacji PR21](TASK_BACKLOG.md), [kontrakt PR22](SUBTASKS.md). Historyczne kontrakty M07/M08/M10 opisują działający kod. Wszędzie, gdzie są sprzeczne z niniejszym dokumentem, ten dokument określa **docelowe** zachowanie, ale nie stan wdrożenia. Najpierw zmieniamy dokumentację, następnie backend, API, UI i testy w osobnych PR-ach. Dotychczasowe zasady ochrony firm, audytu, wersjonowania i wydawania paczek obowiązują.

## Główny scenariusz pracy

Kierownik/brygadzista tworzy pulę planowanych zadań firmy, także bez wykonawców (backlog). Potem przydziela je pracownikom. Zadania są widoczne na pulpicie zgodnie z rolą i służą jako centrum pracy, a nie dodatek ukryty głęboko w projekcie. Obok zadania są podzadania, komentarze i zdjęcia dokumentujące prace.

**Plany projektu (PDF, rysunki, biblioteka dokumentacji i łączenie planu z zadaniem) są odłożone.** Nie dodawać ich do PR21–PR23. Pełne offline dla zapisów, komentarzy i zdjęć pozostaje oddzielnym etapem po dostarczeniu użytecznego przepływu online.

## Macierz docelowa: zadania firmy

| Operacja | Administrator platformy | Administrator firmy | Kierownik | Brygadzista | Pracownik |
|---|---|---|---|---|---|
| Lista wszystkich projektów/zadań własnej firmy | Nie domyślnie | Tak | Tak | Tak | Nie |
| Backlog i tworzenie zadania bez wykonawcy | Nie | Tak | Tak | Tak | Nie |
| Tworzenie, edycja, przydzielanie i zmiana wykonawcy zadań | Nie | Tak | Tak | Tak | Nie |
| Podzadania: tworzenie i delegowanie | Nie | Tak | Tak | Tak | Nie |
| Odczyt własnych przypisanych zadań | Nie domyślnie | Tak | Tak | Tak | Tak, tylko własne |
| Komentarze i zdjęcia na dostępnym zadaniu | Nie | Tak | Tak | Tak | Tak, cała dyskusja na własnym przypisanym zadaniu |
| Rozpoczęcie i zgłoszenie do odbioru | Nie | Tylko własna rola wykonawcy i własny przydział | Tylko własne przydziały | Tylko własne przydziały | Tylko własne przydziały |
| Odbiór prac i zwrot do wykonania | Nie | Docelowo, z regułą braku samo-odbioru | Docelowo, z regułą braku samo-odbioru | Do rozstrzygnięcia w etapie odbiorów | Nie |

Każde „Tak” dotyczy **aktywnej firmy**, aktywnego konta/członkostwa oraz właściwej operacji. Dostęp kierownika i brygadzisty nie wymaga osobnego przydzielenia do każdego projektu firmy; nadal jest ograniczony wyłącznie do własnego tenanta. Administrator firmy zarządza zadaniami bez nadawania sobie dodatkowej roli kierownika. Administrator platformy nie dziedziczy dostępu do projektów/zadań. Obsługa kontrahentów bez kont pozostaje bez zmian.

Pracownik widzi wyłącznie zadania przypisane do jego aktywnego członkostwa, także w różnych projektach firmy. Nadanie zadania **zapewnia odczyt tylko niezbędnego kontekstu projektu i danego zadania**, bez ręcznego kroku „przydziel do projektu” i bez ujawnienia pozostałych zadań, pełnej listy pracowników ani komentarzy czy zdjęć z **innych zadań**. Na zadaniu przypisanym do pracownika widoczna jest **cała historia komentarzy i wszystkie dołączone do nich zdjęcia, niezależnie od autora**. Nie filtrujemy dyskusji zadania po autorze; odcięcie dostępu do zadania odcina również jego dyskusję i media. Dotyczy także dostępu bezpośrednio przez API, identyfikatory obcych firm i offline snapshot. Cofnięcie przydziału/dostępu zamyka odczyt i zapis; zasady ograniczonego offline i unieważniania dostępu pozostają ważne. Profile pracowników bez kont nie są samodzielnie uwierzytelnionymi wykonawcami.

## Backlog, wykonawca i postęp

- Zadanie należy do dokładnie jednej firmy i jednego projektu, a jego `assigneeMembershipId` może być `null`; takie zadanie ma status `planned` i w UI jest w **Backlogu**. Nie dodawać nowego statusu serwerowego `backlog` bez osobnej decyzji.
- Przydzielenie aktywnemu pracownikowi przenosi zadanie do widoku jego pracy (nadal `planned`). Kierownik/brygadzista może odpiąć wykonawcę od **niezaczętego** zadania i przywrócić je do backlogu. Zmiana wykonawcy zadania trwającego lub zgłoszonego do odbioru wymaga osobnego jawnego przepływu, a nie cichego resetu.
- Zachować M08: `planned → in_progress → submitted`, niezmienne identyfikatory komend, idempotencję, `expectedVersion`, audyt i regułę „wykonawca zmienia postęp własnego zadania”. Brak wykonawcy oznacza brak możliwości uruchomienia komendy postępu.
- Przydział musi atomowo walidować aktywne konto, firmę, członkostwo i wersję zadania, a wymagany kontekst projektu ma być autoryzowany pochodnie. Nie używać samego ukrywania elementów UI jako ochrony.
- Nie kasować historycznych zadań ani dotychczasowych przydziałów: migracja dodaje możliwość NULL i zachowuje istniejące rekordy. Rollback po zmianie schematu podlega obecnym kontrolom zgodności i może wymagać restore.

## Pulpit i nawigacja

- **Pulpit jest ekranem podsumowania pracy** (PR25): pełne autoryzowane liczniki statusów w aktywnych projektach i maksymalnie 8 zadań wymagających uwagi. Osobne **Zadania** udostępniają pełną listę i zarządzanie.
- Administrator firmy/kierownik/brygadzista: zadania ze wszystkich projektów tej firmy; zakładki/filtry **Wszystkie, Moje, Backlog, Do zrobienia, W trakcie, Do odbioru**, opcjonalnie projekt i wykonawca; szybkie **Nowe zadanie**, **Przypisz / Zmień wykonawcę**.
- Pracownik: tylko **Moje zadania**, z tytułem, projektem, bieżącym statusem i akcją przejścia do zadania. Nie pokazujemy pustych sekcji administracyjnych ani cudzych zadań.
- Osobna pozycja **Zadania** w nawigacji daje pełną listę, filtry, wyszukiwanie i działania. **Projekty** służą kontekstowi i organizacji, ale nie są obowiązkową drogą do utworzenia/odczytania zadania.
- Szybkie dodawanie wymaga projektu i tytułu; opis oraz wykonawca są opcjonalne. Widok mobilny pozostaje używalny dotykowo, ma jednoznaczne stany pustej listy, błędu, ładowania, braku uprawnień i potwierdzonego wyniku. Liczniki są liczone wyłącznie z autoryzowanego zakresu, bez przecieku statystyk innych firm.
- Utrzymać ochronę szkiców formularzy, niezakończonych komend M08 i bieżące zachowanie PWA. Zmiana kontekstu firmy nie może pozostawić danych poprzedniej firmy na ekranie.

## Podzadania — PR22

Zadanie główne może zawierać podzadania: maksymalnie jeden poziom, bez podzadań podzadań. Każde podzadanie ma własny tytuł, opis, wykonawcę lub backlog, status, wersję i historię M08. Relacja jest niezmienna i należy do tego samego projektu/firmy; PostgreSQL wymusza głębokość i brak cykli. Zarządzający widzi całą hierarchię swojej firmy. Pracownik widzi wyłącznie przypisane mu rekordy oraz minimum kontekstu rodzica `{id,title}`, bez jego pełnego opisu, rodzeństwa i liczników. Sam przydział rodzica nie udostępnia dzieci. Zagregowany postęp dzieci jest dostępny wyłącznie zarządzającym i nie zmienia statusu ani wersji rodzica. Komentarze i zdjęcia online implementuje [PR23](TASK_COMMENTS_MEDIA.md). Szczegóły API, FORCE RLS, UI, M10 i migracji: [PR22](SUBTASKS.md).

## Komentarze i zdjęcia — PR23

Kontrakt implementacji, uprawnienia, API, magazyn i testowany restore: [TASK_COMMENTS_MEDIA](TASK_COMMENTS_MEDIA.md).

Dostępne zadanie i podzadanie mają chronologiczną historię komentarzy z autorem, czasem i opcjonalnie wieloma fotografiami. **Każda osoba uprawniona do odczytu konkretnego zadania (w tym przypisany pracownik) widzi wszystkie jego komentarze i fotografie niezależnie od autora; nie widzi komentarzy/mediów z innych, nieuprawnionych zadań.** API pobierania dyskusji i samych plików musi stosować identyczną autoryzację do wskazanego zadania i aktualnego przydziału, bez filtrowania po autorze. Zdjęcia z aparatu i galerii, miniatury i powiększenie mają działać mobilnie. Każdy odczyt pliku jest uwierzytelniony i sprawdza firmę oraz dostęp do konkretnego zadania; nie wystawiać plików jako publicznych URL. Walidować rozmiar, typ i faktyczną zawartość pliku, nie ufać nazwie/Content-Type, stosować limity i bezpieczne nazwy magazynowe. Domyślnie nie modyfikować/usuwać historii innych osób bez jawnego modelu korekt i audytu.

Pliki w prywatnym trwałym wolumenie poza katalogami wersji (docelowy przykład: `/srv/sitegrid/files`), w PostgreSQL tylko metadane i powiązania. **Backup samego `pg_dump` nie wystarczy**: przed wdrożeniem zdjęć wymagane spójne backup/restore DB+plików, kontrola osieroconych uploadów, limity dysku i test odtworzenia. Obecny updater/rollback nie może usuwać istniejących mediów. W pierwszym etapie upload online; kolejka uploadu offline oddzielnie, bez obietnicy działania zdjęć offline.

## Kolejność wdrożenia i kryteria odbioru

- **PR20: dokumentacja** — tylko aktualizacja decyzji, bez zmian runtime.
- **PR21: backend+frontend backlog, globalna lista zadań i pulpit per rola** — migracja nullable assignee, zadania przekrojowe i autoryzacja na serwerze, szybkie tworzenie/delegowanie, testy funkcjonalne/Playwright, migracji, paczki i rollbacku.
- **PR22: podzadania** — relacje, kontrola uprawnień, UI, audyt i regresja M08.
- **PR23: komentarze i zdjęcia** — API, prywatny storage, autoryzacja, miniatury, backup/restore, limity i testy. **Obowiązkowy warunek pierwszego pilotażu**, łącznie ze sprawdzonym odtworzeniem DB i zdjęć.
- **Po PR23:** kontynuacja M11/M12 (trwałe offline i konflikty) z uwzględnieniem nowych typów danych; odrębny moduł planów PDF/zdjęć projektowych w dalszym terminie. Rzeczywiste numery PR zależą od repozytorium.

**Test odbiorczy PR21:** kierownik/brygadzista firmy A tworzy 10 nieprzypisanych zadań w różnych projektach, widzi je razem w backlogu, przypisuje część dwóm pracownikom bez wcześniejszego projektowego klikania; pracownik X po zalogowaniu widzi na pulpicie tylko swoje, nie może pobrać cudzych przez ID ani poznać ich liczby. Administrator A ma ten sam dostęp zarządczy bez roli manager, administrator platformy nie ma dostępu do zadań A; użytkownik A+B nie miesza danych, a istniejące zadania/statusy pozostają zachowane po migracji.

**Test odbiorczy PR22/PR23:** podzadania zachowują izolację własności i widoczności rodzeństwa; komentarze i zdjęcia nie przeciekają między osobami ani firmami, a odtworzenie DB i wolumenu przywraca historię i media. CI nie zastępuje odbioru na realnym telefonie.
