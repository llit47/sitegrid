# SiteGrid — kontrahenci, projekty, pracownicy i ewidencja godzin

Decyzja produktowa: 2026-10-10. **Stan: założenia i plan, nie wdrożona funkcja.** Dokument doprecyzowuje architekturę i roadmapę; istniejące zachowanie PR1–PR13 pozostaje bez zmian.

## Model działalności i granice dostępu

- Podstawowy scenariusz to **jedna firma wykonawcza**, jej administratorzy, kierownicy i wspólna pula pracowników. Firma realizuje wiele projektów na rzecz różnych kontrahentów. Kontrahent jest wyłącznie rekordem biznesowym, **nie tenantem, kontem, członkostwem ani rolą**.
- Nie usuwamy wielofirmowego modelu PostgreSQL, globalnych użytkowników, organizacji, członkostw, ról, zaproszeń, izolacji RLS i audytu. Pozostają poprawnym fundamentem produktu i mogą nadal obsługiwać więcej niż jedną niezależną firmę. Jedna firma to domyślny *sposób użytkowania*, nie nowe ograniczenie bazy czy regresja API.
- Kontrahent **nie loguje się do SiteGrid**. Nie planujemy panelu klienta, dostępu kontrahenta do projektów ani uprawnień zewnętrznych. Późniejsze raporty przepracowanych godzin mogą być generowane przez uprawnionych pracowników naszej firmy i przekazywane kontrahentowi poza aplikacją.
- Dane kontrahenta należą do konkretnej organizacji (organization_id). Kontrahent ma nazwę i status aktywności; dalsze pola kontaktowe/rozliczeniowe wymagają osobnej decyzji. Projekt należy do dokładnie jednej organizacji i opcjonalnie do jednego kontrahenta z **tej samej organizacji**. Jeden kontrahent może mieć wiele projektów.
- Istniejące projekty nie mogą zniknąć po migracji: nowe powiązanie contractor_id jest początkowo opcjonalne dla danych historycznych. Nie przenosimy projektów między organizacjami i nie podmieniamy ich identyfikatorów. Nowo utworzone projekty powinny wskazywać kontrahenta po wdrożeniu odpowiedniego formularza, z jawnym wyjątkiem dla projektów wewnętrznych, jeśli zostaną zaplanowane.

## Pracownicy i zadania

- Pracownicy i role pozostają na poziomie własnej organizacji; projektowe przydziały są osobne. Pracownik może mieć dostęp do wielu projektów różnych kontrahentów i wiele otwartych zadań. Nie oznacza to pracy w tych miejscach w tym samym czasie.
- **Nie wprowadzamy obowiązkowych brygad ani stałych składów.** Przydzielamy indywidualne osoby do projektów i zadań. Wszelkie ewentualne zespoły w przyszłości nie mogą być wymaganym pośrednikiem do przypisania.
- Aktualny PR12/PR13: jedno zadanie ma jednego wykonawcę (aktywny członek właściwej organizacji i projektu), a postęp może zgłosić tylko uprawniony wykonawca. Zachowujemy tę semantykę i istniejące API. Ewentualne wielu wykonawców **tego samego zadania** to osobna decyzja i oddzielny przyszły PR, bez dorozumianej zmiany statusów i idempotencji M08.
- Uprawnienia do projektów i zadań pozostają zależne od aktywnego członkostwa, roli oraz przydziału projektowego. Sam kontrahent nie daje żadnych uprawnień. Kierownik widzi tylko niezbędne metadane kontrahenta przy projekcie, do którego ma dostęp; pracownik nie otrzymuje przez to listy kontrahentów całej firmy.

## Godziny: rzeczywiste przedziały, nie tylko suma minut

- Przypisanie do zadania i jego status nie jest wpisem czasu pracy. Można mieć wiele otwartych zadań na różnych budowach.
- Do ewidencji godzin i wykrywania kolizji potrzebny jest **początek i koniec każdego odcinka pracy** (czas rzeczywisty), identyfikator pracownika, organizacji i projektu; sam dzień oraz liczba minut z pierwotnego planu M13 nie wystarczają.
- Dwa zatwierdzane odcinki tego samego pracownika w jednej organizacji **nie mogą się nakładać**, także gdy dotyczą różnych projektów lub kontrahentów. Przyjmujemy przedziały półotwarte [start, koniec): odcinek 07:00–12:00 i 12:00–16:00 są dopuszczalne, a 11:00–15:00 koliduje. Każda osoba ma osobny zegar; wpisy innych pracowników nie kolidują.
- Czas przechowujemy jednoznacznie (UTC/offset); strefa IANA projektu albo określona polityką firmy służy do prezentacji i raportów lokalnych, także przy zmianie czasu. Wpisy o statusach roboczych, zatwierdzeniu i korektach wymagają jawnych reguł — nie wolno ukrywać podwójnego naliczenia czasu.
- **Autorytatywna kontrola kolizji jest serwerowa, transakcyjna, dla całej organizacji i danego pracownika**, również przy dwóch równoległych żądaniach i edycji starszego wpisu. W razie kolizji serwer odrzuca zmianę z czytelnym konfliktem bez nadpisywania. Lokalny odczyt offline może ostrzegać o znanych kolizjach, ale nie potrafi zagwarantować braku wpisu z innego urządzenia; taki konflikt musi zostać ujawniony przy synchronizacji, bez utraty lokalnej propozycji.
- Podstawowe raporty godzin mają filtrować według okresu, kontrahenta i projektu oraz sumować czas bez podwójnego naliczania. Eksport CSV/PDF i wysyłka kontrahentowi to późniejszy, osobny zakres; żaden kontrahent nie dostaje konta ani wglądu w inne projekty.

## Plan i zgodność wsteczna

1. **M09 (przygotowany PR PWA): bez zmiany zakresu.** Manifest, service worker cache'ujący wyłącznie wersjonowane zasoby statyczne oraz wersjonowany IndexedDB z partycjami konto/firma/projekt. Bez danych projektowych offline, kolejki i synchronizacji.
2. **M09C (nowy, odrębny etap po M09, przed M10):** model i UI kontrahentów; opcjonalne przypisanie kontrahenta do projektów i filtrowanie, autoryzacja w obrębie organizacji, niezmienione działanie istniejących projektów oraz izolacja tenantów. Oddzielny moduł serwera i interfejsu, mały punkt integracji.
3. **M10–M12:** zachowujemy fundament snapshotów, trwałej kolejki i konfliktów. Snapshot zawiera autoryzowane metadane kontrahenta potrzebne do wyświetlenia projektu, nigdy globalny katalog obcych kontrahentów. Lokalne klucze nadal wyznacza konto/firma/projekt; contractor_id jest metadaną, nie nowym tenantem.
4. **M13:** przed implementacją doprecyzować kontrakt przedziałów godzinowych, własności wpisów, rozliczenia czasu, edycji i blokad między projektami. Jeśli zakres urośnie, podzielić M13 na małe PR-y, nie osłabiając niezmienników i testów.
5. **Po podstawowej ewidencji godzin:** raporty dla kontrahentów jako osobny moduł, bez ich logowania. Obsługa kilku wykonawców jednego zadania pozostaje niezależnym pomysłem na przyszłość.

**Warunek bezpieczeństwa dla każdego PR:** nie modyfikować starych migracji ani historycznych rekordów destrukcyjnie; zapewnić migrację upgrade i testy regresji kont, organizacji, zaproszeń, ról, przydziałów, zadań, M08 receipts, RLS, instalacji, aktualizacji i odmowy niezgodnego rollbacku. Nie scalać samej aktualizacji dokumentacji z implementacją w jednym PR.
