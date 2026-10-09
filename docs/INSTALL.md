# Instalacja SiteGrid — gotowy Debian 13

SiteGrid działa wyłącznie wewnątrz istniejącego Debiana 13 z systemd (LXC, VM lub fizycznego). Operator przygotowuje system; instalator nie zarządza hostem wirtualizacji. Wymagane root, dostęp HTTPS i do podpisanych repozytoriów Debian, 2 vCPU, 2 GiB RAM i 6 GiB wolnego miejsca w `/opt`; zalecane 4 vCPU/8 GiB/40 GiB.

## Jedno polecenie

Pierwszy oficjalny Release **nie został opublikowany**. Nie ma jeszcze działającej komendy pobrania oficjalnej wersji. Przygotowany builder generuje pełną jednolinijkową komendę w `artifacts/INSTALL_COMMAND.txt`: przypięta wersja i SHA-256 bootstrapu, bez wykonywania kodu z main. Docelowy wzorzec jest w README; pełna zweryfikowana komenda trafi do instrukcji po zatwierdzeniu Release.

Jako root w gotowym Debianie operator wkleja tę jedną komendę. Runner sprawdza root/OS, instaluje narzędzia pobierania z APT, pobiera wersjonowany bootstrap i porównuje przypiętą sumę **przed wykonaniem**. Bootstrap zawiera kod instalatora i przypięty publiczny klucz; weryfikuje Ed25519 manifestu, wersję, architekturę, daty i SHA-256 pakietu z publicznego GitHub Release. Bez wcześniejszego kopiowania `ops/`, archiwum lub instalowania PostgreSQL/Node. Brak opublikowanego wydania, zły podpis lub checksum kończą operację; bez fallbacku.

Instalator pyta o origin HTTPS oraz potwierdzenie `TAK`; instaluje PostgreSQL 17, nginx, przypięty Node 24, aplikację, konto systemowe i systemd. Kończy readiness właściwej wersji. Następnie lokalnie:

```sh
sitegrid bootstrap-admin
sitegrid status
```

Hasło administratora jest pobierane bez echa. Aplikacja nie ma publicznej rejestracji. Runtime PostgreSQL używa ograniczonej roli, lokalnego socketu i peer authentication; migracje wykonuje lokalny administrator PostgreSQL.

Domyślnie powstaje lokalny certyfikat TLS na 90 dni. Testowe urządzenie musi mu zaufać; dla domeny zastąp `/etc/sitegrid/tls/cert.pem` i `key.pem` zaufanym certyfikatem i zapewnij odnawianie. Klucz root/0600; przeładowanie: `systemctl reload sitegrid-proxy`. DNS kieruje na IP Debiana. Lokalny certyfikat nie jest gotową konfiguracją publicznej domeny.

## Retry i obce dane

Instalator odmawia przejęcia istniejących katalogów, użytkownika/bazy/roli SiteGrid, obcego nginx i listenerów. Ponowienie wymaga tego samego przypiętego wydania i sumy; zachowuje konfigurację, TLS i DB. Ukończona instalacja wymaga zgodności aktywnej wersji/readiness; inna wersja jest zadaniem update.

P1: trwała faza `dependencies` jest zapisywana przed APT; retry po instalacji nginx dopuszcza wyłącznie jego domyślną niezmienioną konfigurację. `started` następuje po sprawdzeniu nieistnienia DB/roli, przed provisioningiem.

P2: katalog ze znacznikiem jest przygotowany pod prywatną nazwą `/var/lib/.sitegrid-install-*`, a potem opublikowany atomowo jako `/var/lib/sitegrid` przez `renameat2(RENAME_NOREPLACE)` i fsync. Przerwanie między mkdir a zapisem znacznika nie publikuje pustego katalogu. Retry nie przejmuje/nie usuwa starego stagingu ani obcych danych, także pustego katalogu powstałego po preflight. Stary docelowy katalog bez znacznika wymaga inspekcji; pochodzenie nie jest zgadywane. Pozostałości `.incoming`, `.next` lub `.tmp` również zatrzymują operację do inspekcji.

Kod: `/opt/sitegrid/releases/<wersja>` i atomowy `current`. Konfiguracja/TLS: `/etc/sitegrid`; dane PostgreSQL: `/var/lib/postgresql`; stan i backupy: `/var/lib/sitegrid` root/0700. Wszystko trwałe poza katalogiem wydania. Przypięty klucz kontrolera pozostaje poza przełączanym release; aktualizacja nie zamienia go na klucz pobrany z sieci.

## Update i rollback

```sh
sitegrid update
sitegrid rollback
sitegrid status
```

Update pobiera publiczne informacje o kanale, weryfikuje podpis i pokazuje obecną/docelową wersję. Przed pobraniem pakietu i wdrożeniem wymaga `TAK`. Brak nowszej wersji jest jawnym komunikatem; brak Release, błędny podpis, przeterminowanie/cofnięcie manifestu lub zła suma jest błędem. Nie ma automatyzacji w tle. `--yes` jest jawnym potwierdzeniem dla operatora automatyzacji.

Obecny mechanizm zachowuje blokadę operacji, kontrolę migracji/PostgreSQL, chroniony `pg_dump` przed migracją, atomowe przełączenie i readiness. Błąd nie powoduje downgrade DB ani ślepego restore. Rollback przełącza wyłącznie wcześniejszy ukończony release zgodny z obecną historią migracji; w przeciwnym razie wymaga kontrolowanego restore. Stan zaufanej wersji kanału nie cofa się podczas rollbacku.

Manualny tryb z niezależnie zaufanym artefaktem pozostaje:

```sh
sitegrid update --bundle /root/sitegrid-X.Y.Z-linux-x64.tar.gz --version X.Y.Z --sha256 ZAUFANA_SUMA_64_ZNAKI
sitegrid rollback --version X.Y.Z
```

Częściowy zestaw flag jest odrzucany. Tryb manualny może użyć publicznego HTTPS, ale istniejący transport manualny nie podąża za przekierowaniami; oficjalne Releases obsługuje domyślny podpisany kanał. Ręczny instalator `ops/install-sitegrid.sh` pozostaje dostępny operatorowi posiadającemu już zaufane pliki.

## Walidacja i pierwsza publikacja

Testy w repo używają lokalnych podpisanych fixture: autentyczność, checksum, brak Release, retry P1/P2, obce dane, potwierdzenie, update i rollback. Ciężkie testy wykonywać sekwencyjnie na jednorazowym Debianie/systemd. Nie uruchamiać smoke instalacji na istniejących danych.

Proces z tagu, bramka CI, klucz wydawcy i Draft przed publikacją: [RELEASES.md](RELEASES.md). Aktualne wyniki i ograniczenia: [M01_STATUS.md](M01_STATUS.md).
