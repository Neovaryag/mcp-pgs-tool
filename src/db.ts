import pg from "pg";

const { Pool } = pg;

export type PgPool = InstanceType<typeof Pool>;

export function createPool(connectionString: string): PgPool {
  return new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
  });
}

export async function withClient<T>(
  pool: PgPool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
