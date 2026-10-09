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

`npm run check` sprawdza typy, build i testy. Test integracyjny wymaga `TEST_DATABASE_URL` do **osobnej syntetycznej bazy**; bez niej jest jawnie pominięty. CI uruchamia prawdziwy PostgreSQL 17 w izolowanej usłudze runnera (Docker nie jest zależnością instalacji SiteGrid).

Migracje: kolejne `migrations/NNN_nazwa.sql`; suma SHA-256 każdej zapisanej migracji jest weryfikowana. Nie edytuj zastosowanych migracji. Zmiany wykonuje CLI w pojedynczej transakcji, z blokadą PostgreSQL. Serwer nie uruchamia migracji przy starcie i odmawia readiness przy niezgodnym schemacie.
