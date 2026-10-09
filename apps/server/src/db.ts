import pg from 'pg';

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000, statement_timeout: 10000 });
}
