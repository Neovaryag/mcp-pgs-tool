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

const READ_ONLY_SQL = /^(select|with|show|explain)\b/i;
const FORBIDDEN_SQL =
  /\b(insert|update|delete|merge|upsert|truncate|create|alter|drop|grant|revoke|comment|vacuum|analyze|refresh|reindex|cluster|call|copy|listen|notify|set|reset|discard|security\s+label)\b/i;

function normalizeSql(sql: string): string {
  // Remove leading SQL comments before policy checks.
  return sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*\/\*[\s\S]*?\*\//, "")
    .trim();
}

function assertReadOnlySql(sql: string): void {
  const normalized = normalizeSql(sql);
  if (!normalized) {
    throw new Error("SQL is empty.");
  }
  if (!READ_ONLY_SQL.test(normalized)) {
    throw new Error(
      "Blocked by policy: only read-only SQL is allowed (SELECT / WITH / SHOW / EXPLAIN)."
    );
  }
  if (FORBIDDEN_SQL.test(normalized)) {
    throw new Error(
      "Blocked by policy: write/DDL/transaction-control keywords are not allowed."
    );
  }
  // Reject obvious multi-statement payloads.
  if (normalized.includes(";")) {
    throw new Error("Blocked by policy: multi-statement SQL is not allowed.");
  }
}

export async function safeQuery<T extends pg.QueryResultRow>(
  client: pg.PoolClient,
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  assertReadOnlySql(sql);
  return client.query<T>(sql, params);
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
