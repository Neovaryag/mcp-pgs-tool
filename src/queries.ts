import type pg from "pg";
import { safeQuery } from "./db.js";

export async function getServerInfo(client: pg.PoolClient) {
  const v = await safeQuery<{ version: string; current_database: string }>(
    client,
    `SELECT version(), current_database()`
  );
  return v.rows[0];
}

export async function listSchemas(client: pg.PoolClient) {
  const r = await safeQuery<{ schema_name: string }>(
    client,
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     ORDER BY schema_name`
  );
  return r.rows;
}

export type TableRow = {
  table_schema: string;
  table_name: string;
  table_type: string;
  row_estimate: string | null;
};

export async function listTables(
  client: pg.PoolClient,
  opts: { schemas?: string[] }
): Promise<TableRow[]> {
  const params: unknown[] = [];
  let schemaFilter = "";
  if (opts.schemas?.length) {
    params.push(opts.schemas);
    schemaFilter = `AND c.table_schema = ANY($${params.length}::text[])`;
  }
  const sql = `
    SELECT c.table_schema, c.table_name, c.table_type,
           (SELECT reltuples::bigint::text FROM pg_class cl
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE n.nspname = c.table_schema AND cl.relname = c.table_name
              AND cl.relkind IN ('r','p') LIMIT 1) AS row_estimate
    FROM information_schema.tables c
    WHERE c.table_type IN ('BASE TABLE', 'VIEW')
      AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ${schemaFilter}
    ORDER BY c.table_schema, c.table_name`;
  const r = await safeQuery<TableRow>(client, sql, params);
  return r.rows;
}

export type ColumnRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

export type ColumnBrief = {
  table_schema: string;
  table_name: string;
  column_name: string;
};

export async function listColumnsForTables(
  client: pg.PoolClient,
  tables: { schema: string; name: string }[]
): Promise<ColumnBrief[]> {
  if (!tables.length) return [];
  const values = tables.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`).join(", ");
  const params = tables.flatMap((t) => [t.schema, t.name]);
  const sql = `
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE (c.table_schema, c.table_name) IN (${values})
    ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
  const r = await safeQuery<ColumnBrief>(client, sql, params);
  return r.rows;
}

export async function listColumns(
  client: pg.PoolClient,
  opts: { schema?: string; table?: string }
): Promise<ColumnRow[]> {
  const params: unknown[] = [];
  const filters: string[] = [`c.table_schema NOT IN ('pg_catalog','information_schema')`];
  if (opts.schema) {
    params.push(opts.schema);
    filters.push(`c.table_schema = $${params.length}`);
  }
  if (opts.table) {
    params.push(opts.table);
    filters.push(`c.table_name = $${params.length}`);
  }
  const sql = `
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
           c.is_nullable, c.column_default
    FROM information_schema.columns c
    WHERE ${filters.join(" AND ")}
    ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
  const r = await safeQuery<ColumnRow>(client, sql, params);
  return r.rows;
}

export type TableStatRow = {
  schemaname: string;
  relname: string;
  seq_scan: number;
  idx_scan: number;
  n_tup_ins: number;
  n_tup_upd: number;
  n_tup_del: number;
  n_live_tup: number;
  n_dead_tup: number;
  seq_tup_read: number;
  idx_tup_fetch: number;
  last_vacuum: Date | null;
  last_autovacuum: Date | null;
  last_analyze: Date | null;
  last_autoanalyze: Date | null;
  activity_score: string;
};

export async function tableStatistics(
  client: pg.PoolClient,
  opts: { order: "hot" | "cold"; limit: number }
): Promise<TableStatRow[]> {
  const dir = opts.order === "hot" ? "DESC" : "ASC";
  const sql = `
    SELECT schemaname, relname,
           seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del,
           n_live_tup, n_dead_tup, seq_tup_read, idx_tup_fetch,
           last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
           (COALESCE(seq_tup_read,0) + COALESCE(idx_tup_fetch,0)
            + COALESCE(n_tup_ins,0) + COALESCE(n_tup_upd,0) + COALESCE(n_tup_del,0))::text AS activity_score
    FROM pg_stat_user_tables
    ORDER BY (COALESCE(seq_tup_read,0) + COALESCE(idx_tup_fetch,0)
              + COALESCE(n_tup_ins,0) + COALESCE(n_tup_upd,0) + COALESCE(n_tup_del,0)) ${dir}
    LIMIT $1`;
  const r = await safeQuery<TableStatRow>(client, sql, [opts.limit]);
  return r.rows;
}

export type ColumnStatRow = {
  schemaname: string;
  tablename: string;
  attname: string;
  inherited: boolean;
  null_frac: number;
  avg_width: number;
  n_distinct: number;
  correlation: number | null;
  most_common_vals: string | null;
};

export async function columnStatistics(
  client: pg.PoolClient,
  opts: { limit: number; minNullFrac?: number }
): Promise<ColumnStatRow[]> {
  const minNull = opts.minNullFrac ?? 0;
  const sql = `
    SELECT schemaname, tablename, attname, inherited,
           null_frac, avg_width, n_distinct, correlation,
           most_common_vals::text AS most_common_vals
    FROM pg_stats
    WHERE schemaname NOT IN ('pg_catalog','information_schema')
      AND null_frac >= $2
    ORDER BY null_frac DESC, abs(n_distinct) ASC NULLS LAST
    LIMIT $1`;
  const r = await safeQuery<ColumnStatRow>(client, sql, [opts.limit, minNull]);
  return r.rows;
}

export type UnindexedColumnRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
};

export async function columnsNotInAnyIndex(
  client: pg.PoolClient,
  opts: { limit: number }
): Promise<UnindexedColumnRow[]> {
  const sql = `
    WITH indexed AS (
      SELECT DISTINCT n.nspname AS table_schema,
             c.relname AS table_name,
             a.attname AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey::int[]) AS attnum(attnum)
      JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attnum = attnum.attnum AND NOT a.attisdropped
      WHERE c.relkind IN ('r','p') AND attnum.attnum > 0
    )
    SELECT col.table_schema, col.table_name, col.column_name, col.data_type
    FROM information_schema.columns col
    WHERE col.table_schema NOT IN ('pg_catalog','information_schema')
      AND EXISTS (
        SELECT 1 FROM pg_class pc
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE pn.nspname = col.table_schema AND pc.relname = col.table_name
          AND pc.relkind IN ('r','p')
      )
      AND NOT EXISTS (
        SELECT 1 FROM indexed ix
        WHERE ix.table_schema = col.table_schema
          AND ix.table_name = col.table_name
          AND ix.column_name = col.column_name
      )
    ORDER BY col.table_schema, col.table_name, col.column_name
    LIMIT $1`;
  const r = await safeQuery<UnindexedColumnRow>(client, sql, [opts.limit]);
  return r.rows;
}

export async function hasPgStatStatements(client: pg.PoolClient): Promise<boolean> {
  const r = await safeQuery<{ exists: boolean }>(
    client,
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS exists`
  );
  return Boolean(r.rows[0]?.exists);
}

/** PG13+ раздельное время планирования/исполнения; PG12 и ниже — total_time/mean_time. */
export async function pgStatStatementsUsesExecTimeColumns(
  client: pg.PoolClient
): Promise<boolean> {
  const r = await safeQuery<{ ok: boolean }>(
    client,
    `SELECT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'pg_stat_statements'
         AND n.nspname = ANY (SELECT unnest(current_schemas(false)))
         AND a.attname = 'total_exec_time'
         AND NOT a.attisdropped
         AND a.attnum > 0
     ) AS ok`
  );
  return Boolean(r.rows[0]?.ok);
}

export type StatStatementSort =
  | "total_time"
  | "mean_time"
  | "calls"
  | "rows"
  | "shared_blks_read";

export type StatStatementRow = {
  userid: number | null;
  dbid: number | null;
  queryid: string | null;
  calls: number;
  total_time_ms: number;
  mean_time_ms: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  /** Нормализованный текст запроса (может быть длинным). */
  query: string;
};

const SORT_COLUMNS: Record<
  StatStatementSort,
  { modern: string; legacy: string }
> = {
  total_time: { modern: "total_exec_time", legacy: "total_time" },
  mean_time: { modern: "mean_exec_time", legacy: "mean_time" },
  calls: { modern: "calls", legacy: "calls" },
  rows: { modern: "rows", legacy: "rows" },
  shared_blks_read: { modern: "shared_blks_read", legacy: "shared_blks_read" },
};

export async function pgStatStatementsTop(
  client: pg.PoolClient,
  opts: {
    sortBy: StatStatementSort;
    limit: number;
    minCalls: number;
    queryContains?: string;
    currentDatabaseOnly: boolean;
    maxQueryChars: number;
  }
): Promise<StatStatementRow[]> {
  const modern = await pgStatStatementsUsesExecTimeColumns(client);
  const totalCol = modern ? "total_exec_time" : "total_time";
  const meanCol = modern ? "mean_exec_time" : "mean_time";
  const sortCol = modern ? SORT_COLUMNS[opts.sortBy].modern : SORT_COLUMNS[opts.sortBy].legacy;
  const params: unknown[] = [];
  const where: string[] = [];

  params.push(opts.minCalls);
  where.push(`calls >= $${params.length}`);

  if (opts.currentDatabaseOnly) {
    where.push(`dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  }

  if (opts.queryContains !== undefined && opts.queryContains.trim() !== "") {
    const escaped = opts.queryContains
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    params.push(`%${escaped}%`);
    where.push(`query ILIKE $${params.length} ESCAPE '\\'`);
  }

  params.push(opts.limit);
  const limitIdx = params.length;

  const qLen = Math.max(200, Math.min(opts.maxQueryChars, 32_000));

  const sql = `
    SELECT userid, dbid, queryid::text AS queryid,
           calls,
           ${totalCol}::float8 AS total_time_ms,
           ${meanCol}::float8 AS mean_time_ms,
           rows,
           shared_blks_hit,
           shared_blks_read,
           left(query, ${qLen}) AS query
    FROM pg_stat_statements
    WHERE ${where.join(" AND ")}
    ORDER BY ${sortCol} DESC NULLS LAST
    LIMIT $${limitIdx}`;
  const r = await safeQuery<StatStatementRow>(client, sql, params);
  return r.rows;
}

export type StatStatementsInfoRow = Record<string, unknown>;

/** Есть не во всех версиях расширения; при отсутствии — null. */
export async function pgStatStatementsInfo(
  client: pg.PoolClient
): Promise<StatStatementsInfoRow | null> {
  try {
    const r = await safeQuery<StatStatementsInfoRow>(
      client,
      `SELECT * FROM pg_stat_statements_info LIMIT 1`
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}
