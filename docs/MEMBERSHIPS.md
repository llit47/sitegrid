# M02B — członkostwa, role i izolacja PostgreSQL

Migracja `004_memberships_roles.sql` rozszerza schemat 3 po M02A do 4, bez zmian istniejących kont, haseł, sesji, administratorów platformy i firm. Nie tworzy automatycznych członkostw ani ról dla istniejących kont. Kontrakt wydania wymaga schematu 4; kod poprzedniego wydania deklarujący wyłącznie schemat 3 nie jest z nim zgodny.

## Model

`users` pozostaje globalną tożsamością. `organization_memberships` ma klucz główny `(organization_id, id)`, unikalne `(organization_id, user_id)` i FK do istniejących `organizations` oraz `users`. Status jest lokalny dla firmy: `pending` (domyślny), `active`, `inactive`. Ten sam użytkownik może mieć członkostwo w wielu firmach; dezaktywacja jednego nie zmienia pozostałych ani globalnego konta.

`membership_roles` pozwala na kilka jawnych ról na członkostwo. Klucz główny to `(organization_id, membership_id, role)`, a FK `(organization_id, membership_id)` wskazuje członkostwo **tej samej firmy**. Usunięcie członkostwa z przypisanymi rolami wymaga ich jawnego usunięcia; brak kaskadowego kasowania historii.

| Wartość w DB | Rola z PERMISSIONS.md |
|---|---|
| `organization_admin` | Administrator firmy |
| `manager` | Kierownik |
| `foreman` | Brygadzista |
| `worker` | Pracownik |

Rola platformowa pozostaje w `platform_admins` i nie może być wpisana do `membership_roles`. Role nie dziedziczą po sobie; administrator firmy może otrzymać dodatkową rolę kierownika. Uprawnienia projektowe oraz reguła ostatniego administratora należą do dalszych etapów wskazanych w roadmapie.

## Granica RLS i kontekst transakcji

Obie nowe tabele tenantowe mają `ENABLE` i `FORCE ROW LEVEL SECURITY`. Polityki `USING` oraz `WITH CHECK` wymagają zgodności `organization_id` z `sitegrid.organization_id`. Brak lub pusty kontekst daje zero rekordów przy odczycie/UPDATE/DELETE i odmowę INSERT; zmiana firmy rekordu oraz zapis do obcej firmy są odrzucane. Błędny UUID kontekstu powoduje błąd, bez dostępu do danych. Złożone FK niezależnie blokują łączenie firm.

`organizations` jest istniejącym katalogiem panelu platformy M02A, a `platform_audit_events` jego audytem. Ich dotychczasowa obsługa pozostaje za autoryzacją administratora platformy w API. M02B izoluje członkostwa i role, bez zmian endpointów M02A, logowania ani globalnych tabel tożsamości. Rola platformowa nie daje wyjątków od polityk nowych tabel.

Migracje wykonuje osobny właściciel. Migracja odmawia działania jako `sitegrid` oraz przy istniejącym runtime posiadającym superuser/`BYPASSRLS`/`CREATEROLE` lub członkostwo w takiej roli albo w roli właściciela migracji. Przyznaje istniejącej roli `sitegrid` tylko SELECT/INSERT/UPDATE/DELETE nowych tabel, bez TRUNCATE czy własności. Role infrastruktury pozostają kontrolowane przez operatora; superuser może omijać RLS. Zasady PostgreSQL: [RLS w wersji 17](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

`withOrganization(pool, organizationId, callback)` w `apps/server/src/organization-context.ts` pobiera jedno połączenie, rozpoczyna transakcję i wykonuje parametryzowane `set_config('sitegrid.organization_id', ..., true)`. Ustawienie obowiązuje lokalnie do COMMIT/ROLLBACK; helper zwraca połączenie po zakończeniu transakcji, a przy błędzie rollbacku usuwa je z puli. Callback korzysta wyłącznie z przekazanego klienta i nie zarządza sam transakcją. Nie używać sesyjnego `SET` ani ustawiać kontekstu przez `pool.query`. [Lokalność `set_config`](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET).

Helper wymaga identyfikatora firmy **wcześniej autoryzowanego przez wywołującego**. RLS jest barierą zakresu firmy, nie autoryzacją aktora. Runtime potrafi ustawić kontekst SQL; sam UUID lub rola platformowa nie dowodzi prawa użytkownika do firmy. M03 dopiero doda sprawdzanie aktywnego konta, firmy, członkostwa i ról oraz API wyboru kontekstu. Przechowywanie statusu `inactive` nie zastępuje tych sprawdzeń. Helper nie jest jeszcze podłączony do endpointów.

## Testy

`tests/memberships.test.ts` używa PostgreSQL 17 w CI: dwie firmy, jedna wspólna tożsamość, różne statusy i role, odczyt i zapis obcych danych, brak kontekstu, FK/unikalność/katalog ról oraz migracja 3 → 4 z zachowaniem danych globalnych. RLS sprawdza rzeczywiste logowanie jako `sitegrid`, zarówno `current_user`, jak i `session_user`, a także brak własności tabel i uprawnień obejścia RLS. Pula o rozmiarze 1 i identyczny `pg_backend_pid()` dowodzą resetu kontekstu po commicie, błędzie callbacku i błędzie SQL; rollback zachowuje wcześniejszy status członkostwa. Przygotowanie lokalnej syntetycznej bazy i zmienne środowiskowe: [DEVELOPMENT.md](DEVELOPMENT.md).
