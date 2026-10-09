# Publiczne wydania SiteGrid

Repozytorium i kanał instalacji: publiczne GitHub Releases `llit47/sitegrid`. Klient nie używa uwierzytelnienia GitHub. Wydawca podpisuje manifest Ed25519; klucz publiczny jest przypięty w bootstrapie i kontrolerze instalacji. SHA-256 obok paczki ma znaczenie pomocnicze; autentyczność pochodzi z podpisu i przypiętego klucza, a pierwsze wykonanie bootstrapu z sumy przypiętej w zaufanej instrukcji.

## Przygotowanie klucza i wydania

1. Klucz wydawcy wygenerowano po zgodzie użytkownika; do `ops/release-public.pem` trafiła tylko publiczna część Ed25519 (SHA-256 pliku PEM: `3a6e17d95f6db366e851e530f1029669cd72cba3cf7e5baea024af6bec4c7094`). Prywatny klucz jest poza repo w `/home/codex/.local/share/sitegrid-release-signing/ed25519.pem`, z prawami 0600 i katalogiem 0700. Przed wydaniem operator musi wykonać bezpieczną kopię poza LXC. Aktualizator używa kotwicy `/usr/local/lib/sitegrid/release-public.pem` zachowanej od instalacji; zmiana kotwicy wymaga oddzielnego przeglądu, nie pobieramy nowego klucza z aktualizowanego wydania.
2. Skonfigurować środowisko GitHub Actions `release-signing` z wymaganym zatwierdzeniem operatora i sekretem `SITEGRID_ED25519_KEY`. Workflow sprawdza, że sekret odpowiada przypiętemu kluczowi. Klient instalacji/aktualizacji nie otrzymuje tego sekretu. Branch CI może użyć efemerycznego klucza fixture; tag wymaga prawdziwego przypiętego klucza.
3. Po akceptacji zmian i integracji przez operatora wskazać commit main, ustawić spójne `package.json`, `release.json` i tag `vX.Y.Z`. Nie tagować ruchomego ani nieprzetestowanego kodu. Workflow odrzuca tag spoza historii main i tag prerelease.
4. Push tagu wywołuje reusable CI: typecheck/build/testy aplikacji, paczka z przypiętym Node, testy Python i walidacje skryptów. Dopiero po sukcesie i bramce środowiska workflow pobiera **ten sam sprawdzony artefakt**, tworzy deterministyczny bootstrap i podpisuje manifest. Brak klucza lub niezgodność podpisu zatrzymuje proces.
5. Workflow tworzy wyłącznie **Draft Release**. Pierwsze publiczne wydanie wymaga osobnego zatwierdzenia użytkownika i ręcznego opublikowania gotowego Draft. Żadnego automatycznego publikowania, `--clobber` ani nadpisywania wydanych assetów. Do tej pory nie utworzono tagu ani Release.

Obecny workflow buduje Linux x64. Kod potrafi zweryfikować arm64, ale instalacja arm64 wymaga oddzielnej przetestowanej paczki wymienionej w podpisanym manifeście; brak takiej paczki zatrzymuje instalator.

## Format i transport

Assets: `sitegrid-X.Y.Z-linux-x64.tar.gz`, `sitegrid-install-X.Y.Z.sh`, `sitegrid-manifest.json`, binarny `sitegrid-manifest.sig`, pomocnicze `.sha256` i `INSTALL_COMMAND.txt`. Manifest wiąże repozytorium, kanał stable, wersję/tag, architekturę, nazwę i SHA-256 każdego pakietu oraz bootstrapu. Jest ważny 90 dni; przed wygaśnięciem trzeba opublikować kolejne przetestowane wydanie. Klient odrzuca przyszłą/przeterminowaną datę i cofnięcie poniżej zaufanej wersji zapisanej w trwałym stanie, również po rollbacku.

GitHub API `/releases/latest` jest wyłącznie lokalizatorem tagu. Kod nie wykonuje danych z tego endpointu: przed pobraniem/uruchomieniem paczki sprawdza podpis manifestu i zgodność wersji. Instalacja zawsze wybiera wersję przypiętą w bootstrapie. Transport pozwala wyłącznie na HTTPS i wskazane hosty GitHub, ma limity czasu/rozmiaru i kontroluje przekierowania; nie przenosi żadnych poświadczeń.

## Narzędzia lokalne

```sh
node scripts/package-release.mjs X.Y.Z
python3 scripts/build-bootstrap.py X.Y.Z
python3 scripts/sign-release.py X.Y.Z --key-file /BEZPIECZNA_SCIEZKA/ed25519.pem
```

Te polecenia nie publikują. `sign-release.py` odrzuca klucz prywatny umieszczony w repozytorium oraz klucz o niebezpiecznych prawach. Przygotowaną komendę z `artifacts/INSTALL_COMMAND.txt` należy opublikować w zaufanej instrukcji dopiero po sprawdzeniu Draft i zatwierdzeniu publikacji. Nie pobierać samej sumy i skryptu z niezweryfikowanego miejsca, po czym traktować tej pary jako zaufanej.

Testy korzystają z lokalnych, podpisanych fixture i efemerycznych kluczy poza repozytorium. Są niezależne od dostępności pierwszego publicznego Release. Artefakt CI z kluczem fixture nie jest oficjalnym wydaniem.
