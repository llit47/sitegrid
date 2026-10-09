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

M02A dodaje `003_organizations.sql`, M02B `004_memberships_roles.sql`, M03 `005_organization_access.sql`, a PR9 `006_invitations.sql`; kontrakt `release.json` wymaga schematu 6 i dopuszcza migrację ze schematów 0–6. Testy integracyjne sprawdzają przejście ze schematów 2, 3, 4 i 5 z zachowaniem kont, firm, członkostw i ról oraz powtórzenie migracji.

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
