# Uruchomienie developerskie

Node.js 24 LTS i PostgreSQL 17+. `npm ci`, skopiuj `.env.example` do `.env` i ustaw lokalną bazę; nigdy nie commituj sekretów.

```sh
npm ci
node --env-file=.env --import tsx apps/server/src/migrate-cli.ts
npm run dev:api
# drugi terminal
npm run dev:web
```

Frontend: http://localhost:5173. Produkcja: `npm run build`, `NODE_ENV=production`, `DATABASE_URL`, `PUBLIC_ORIGIN=https://twoja-domena`, `npm start` w katalogu wydania. API domyślnie słucha wyłącznie na loopback; reverse proxy dostarcza HTTPS i frontend z tego samego origin.

`npm run check` sprawdza typy, compiler lint, build i testy. Testy integracyjne wymagają `TEST_DATABASE_URL` do **osobnej syntetycznej bazy**; bez niej są jawnie pominięte. CI uruchamia prawdziwy PostgreSQL 17 w izolowanej usłudze runnera (Docker nie jest zależnością instalacji SiteGrid). M02A obejmuje tworzenie/odczyt firm, walidację, sesje i uprawnienia, CSRF/Origin oraz atomowy audyt; `node --import tsx --test tests/organizations.test.ts` uruchamia ten zestaw osobno.

Migracje: kolejne `migrations/NNN_nazwa.sql`; suma SHA-256 każdej zapisanej migracji jest weryfikowana. Nie edytuj zastosowanych migracji. Zmiany wykonuje CLI w pojedynczej transakcji, z blokadą PostgreSQL. Serwer nie uruchamia migracji przy starcie i odmawia readiness przy niezgodnym schemacie.

M02A dodaje `003_organizations.sql`, M02B `004_memberships_roles.sql`, M03 `005_organization_access.sql`, PR9 `006_invitations.sql`, a PR10 `007_company_members.sql`; kontrakt `release.json` wymaga schematu 7 i dopuszcza migrację ze schematów 0–7. Testy integracyjne sprawdzają przejście ze schematów 2, 3, 4, 5 i 6 z zachowaniem kont, firm, członkostw, ról i zaproszeń oraz powtórzenie migracji.

Migracja przyznaje istniejącej roli runtime `sitegrid` odczyt/tworzenie firm i zapis audytu. Test z kontem PostgreSQL superuser sprawdza API z tą rolą; w razie jej braku tworzy tymczasową rolę `NOLOGIN` i usuwa ją po teście. Przy mniej uprzywilejowanej bazie tylko ten dodatkowy scenariusz jest pomijany.

M02B: [kontrakt członkostw i RLS](MEMBERSHIPS.md). Test `tests/memberships.test.ts` wymaga także `TEST_RUNTIME_DATABASE_URL` wskazującego **osobne logowanie jako `sitegrid`**, bez superuser/`BYPASSRLS`/`CREATEROLE`, własności tabel lub członkostwa w roli migracyjnej. Rola musi istnieć przed testami; konto `TEST_DATABASE_URL` tworzy osobny schemat i przyznaje jej `USAGE`. W syntetycznej bazie przygotuj rolę:

```sql
CREATE ROLE sitegrid LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

Skonfiguruj uwierzytelnianie zgodnie z lokalną bazą; nie zapisuj haseł w repo. CI tworzy tę rolę przed `npm run check` i łączy się bezpośrednio jako `sitegrid` z PostgreSQL 17. Przy ustawionym `TEST_DATABASE_URL` brak runtime URL powoduje błąd, a nie pominięcie testów RLS. Osobne uruchomienie:

```sh
TEST_DATABASE_URL=postgresql://migration_owner@localhost/sitegrid_test \
TEST_RUNTIME_DATABASE_URL=postgresql://sitegrid@localhost/sitegrid_test \
node --import tsx --test tests/memberships.test.ts
```

M03 używa tych samych dwóch połączeń testowych; `node --import tsx --test tests/organization-context.test.ts` uruchamia testy API, autoryzacji i polityk listowania firm. Zestaw wymaga rzeczywistego runtime URL i jest automatycznie objęty `npm run check` w CI. [Kontrakt M03](ORGANIZATION_CONTEXT.md).

PR9: [zaproszenia email, SMTP i aktywacja administratora firmy](INVITATIONS.md). Testy korzystają z tych samych dwóch połączeń PostgreSQL i są objęte `npm run check`.

PR10: [panel firmy, członkowie, pracownicy i ochrona ostatniego administratora](COMPANY_MEMBERS.md). `tests/company-members.test.ts` korzysta z tych samych dwóch połączeń, rzeczywistego runtime RLS i jest objęty `npm run check`. Zmiany administracji wymagają `READ COMMITTED` (domyślne dla aplikacji). Używaj świeżej syntetycznej bazy PostgreSQL 17+ z kodowaniem UTF-8.

PR11 (M06): [branding i ustawienia firmy](COMPANY_BRANDING.md). Migracja `008_organization_branding.sql` wymaga schematu 8 (upgrade 0–8). `tests/organization-branding.test.ts` używa tych samych dwóch połączeń i rzeczywistego runtime RLS; `npm run check` wykonuje także pełne regresje PR10. Obrazy dekoduje przypięty `sharp`; paczka produkcyjna musi zawierać natywne zależności platformy. Nie używaj `npm ci --omit=optional`.

Opcjonalny test UI PR11 (po `npm run build`, z oboma testowymi URL PostgreSQL): `node --import tsx tests/organization-branding-browser.mjs`. Wymaga Playwright i Chromium w środowisku testowym; ścieżki można podać przez `SITEGRID_PLAYWRIGHT_MODULE` i `SITEGRID_CHROMIUM_PATH`. Test sam tworzy i usuwa syntetyczny schemat, sprawdza desktop/mobile, zapis, logo, konflikty oraz opóźnione odpowiedzi przy przełączaniu firmy. Nie używa danych wdrożenia.

PR12 (M07): [projekty, przydziały i zadania online](PROJECTS_TASKS.md). Migracja `009_projects_tasks.sql` podnosi schemat 8 → 9; aktualny kontrakt wymaga 9 i dopuszcza upgrade 0–9. `tests/projects-tasks.test.ts` używa tych samych dwóch URL i rzeczywistego runtime FORCE RLS; jest częścią `npm run check`. Zawiera także dane PR11 przy migracji, wersje, audyt, obce projekty i wykonawców oraz odwołanie dostępu podczas oczekiwania na blokadę.

Opcjonalny test UI PR12 po buildzie: `node --import tsx tests/projects-browser.mjs`, z oboma testowymi URL i lokalnym Playwright/Chromium jak dla testu PR11. Sprawdza desktop i ekran 390 px, zakresy ról, projekty/przydziały/zadania, konflikt, błędy i opóźnione odpowiedzi. Nie tworzy PWA ani cache offline.

PR13 (M08): [komendy postępu](TASK_PROGRESS.md), osobny moduł `apps/server/src/task-progress/`, migracja `010_task_progress.sql` 9 → 10 i release contract 10 (upgrade 0–10). `tests/task-progress.test.ts` jest częścią `npm run check` z oboma URL PostgreSQL. Obejmuje także socket utracony po COMMIT i retry w osobnym procesie Node. Po buildzie: `node --import tsx tests/task-progress-browser.mjs`, z tymi samymi URL oraz Playwright/Chromium jak PR12. Nie ma kolejki offline; niejednoznaczny wynik UI ponawia w pamięci komponentu z tym samym operationId.

PR15 (M09): [powłoka PWA i IndexedDB](PWA_STORAGE.md). Bez migracji SQL; kontrakt PostgreSQL nadal 10. `npm run check` obejmuje `tests/pwa.test.ts`: wygenerowany manifest/ikony/assets, digests, polityka worker/cache, offline fallback, aktualizacja/rollback oraz publiczne headers. Po buildzie `node --import tsx tests/pwa-browser.mjs` z tymi samymi dwoma URL i `SITEGRID_PLAYWRIGHT_MODULE`/`SITEGRID_CHROMIUM_PATH` sprawdza rzeczywisty worker/IndexedDB, desktop 1280 px i mobile 390 px, offline reload/reconnect, login/logout/zmianę konta, upgrade i błędy storage. Test ma wyłącznie syntetyczne dane i testowe endpointy niedostarczane w produkcji. Nadal uruchamiaj zestawy browser PR11–PR13 jako regresję.

PR16 (M09C): [kontrahenci i powiązania projektów](CONTRACTORS.md). Migracja `011_contractors.sql` podnosi schemat 10 → 11; bieżący kontrakt wydania wymaga 11 i dopuszcza upgrade 0–11. `node --import tsx --test tests/contractors.test.ts` z oboma testowymi URL sprawdza populowany schemat 10 (także receipt M08), świeżą instalację, role, złożone FK, FORCE RLS, wersje, audyt/rollback i uprawnienia po blokadzie. Jest częścią `npm run check`. Po buildzie `node --import tsx tests/contractors-browser.mjs` z tymi samymi URL i Playwright/Chromium sprawdza desktop/mobile, formularze, historyczne powiązania, filtr, opóźnione odpowiedzi i wielu kontrahentów jednego pracownika. Uruchamiaj też wszystkie cztery wcześniejsze zestawy browser (PWA, branding, projekty, postęp). Test PWA używa rzeczywistego workera i sprawdza wykluczenie kontrahentów z cache; zestaw kontrahentów blokuje worker dla deterministycznego routingu HTTP. Python z rzeczywistą paczką sprawdza kompletność modułów/migracji i upgrade 10 → 11 oraz odmowę niezgodnego rollbacku.
