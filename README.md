# mcp-pgs-tool

**TypeScript** [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **PostgreSQL**: database schema, table activity stats, heuristics for “cold” columns, columns not covered by any index, top queries from **`pg_stat_statements`** (when the extension is installed), and a rough **codebase scan** for table/column name mentions under a local directory.

Transport: **stdio** (one line = one JSON-RPC message, as used by `@modelcontextprotocol/sdk`).

---

## Table of contents

- [Requirements](#requirements)
- [Install and build](#install-and-build)
- [Environment variables](#environment-variables)
- [Cursor setup](#cursor-setup)
- [Tools](#tools)
- [PostgreSQL: permissions and extensions](#postgresql-permissions-and-extensions)
- [Testing without Cursor](#testing-without-cursor)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

---

## Requirements

| Component | Version |
|-----------|---------|
| Node.js | **≥ 20** |
| PostgreSQL | **12+** recommended (`pg_stat_statements_top` maps `total_time` vs `total_exec_time` automatically) |

---

## Install and build

```bash
git clone <your-repo-url>
cd mcp-pgs-tool
npm install
npm run build
```

After a successful build, the entry file is **`dist/index.js`**.

Manual run (reads JSON-RPC from stdin; not meant for interactive use):

**Windows (cmd)**

```bat
set DATABASE_URL=postgres://user:password@host:5432/dbname
node dist\index.js
```

**macOS / Linux**

```bash
export DATABASE_URL=postgres://user:password@host:5432/dbname
node dist/index.js
```

Optional global CLI via `npm link` (exposes the `mcp-pgs-tool` binary pointing at `dist/index.js`).

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| **`DATABASE_URL`** | Yes, for any tool that hits the database | PostgreSQL connection URI, e.g. `postgres://user:pass@localhost:5432/mydb` or `postgresql://...` |

If `DATABASE_URL` is missing, the process still starts, but DB tools return an error payload in the tool result (JSON with `ok: false` / `error`).

---

## Cursor setup

In **Cursor Settings → MCP**, register a server. Use **absolute paths** for `node` and `dist/index.js`, and pass `DATABASE_URL` under `env`.

### Windows example

```json
{
  "mcpServers": {
    "pgs-tool": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\YOUR_USER\\IdeaProjects\\mcp-pgs-tool\\dist\\index.js"
      ],
      "env": {
        "DATABASE_URL": "postgres://USER:PASSWORD@localhost:5432/DBNAME"
      }
    }
  }
}
```

If `node` is on `PATH`:

```json
{
  "mcpServers": {
    "pgs-tool": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\mcp-pgs-tool\\dist\\index.js"],
      "env": {
        "DATABASE_URL": "postgres://USER:PASSWORD@localhost:5432/DBNAME"
      }
    }
  }
}
```

Reload MCP or Cursor and confirm tools whose names start with `pg_` appear in the tool list.

---

## Tools

Most tools return a single text block `content[0].text` containing **JSON** (easy for agents to parse).

### `pg_health`

Connection check: server version, current database name, whether the **`pg_stat_statements`** extension exists.

| Parameter | Type | Default |
|-----------|------|---------|
| — | — | — |

---

### `pg_list_schemas`

Schemas from `information_schema`, excluding system schemas (`pg_catalog`, `information_schema`, `pg_toast`).

---

### `pg_list_tables`

Tables and views: schema, name, type, row estimate from `reltuples`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `schemas` | `string[]?` | Only include these schemas |

---

### `pg_list_columns`

Columns from `information_schema`: data type, nullability, default.

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `string?` | Filter by schema |
| `table` | `string?` | Filter by table name |

---

### `pg_table_activity`

Stats from **`pg_stat_user_tables`**: sequential/index scans, tuple inserts/updates/deletes, `seq_tup_read`, `idx_tup_fetch`, maintenance timestamps.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `order` | `"hot"` \| `"cold"` | `"cold"` | Sort by combined activity |
| `limit` | `integer` | `50` | 1…500 |

With **`order: "cold"`**, rows are sorted by **ascending**  
`(seq_tup_read + idx_tup_fetch + n_tup_ins + n_tup_upd + n_tup_del)` — candidates for “low traffic” tables relative to accumulated stats.

---

### `pg_column_stats_suspicious`

Planner statistics from **`pg_stats`**: `null_frac`, `n_distinct`, `correlation`, truncated `most_common_vals`.

| Parameter | Type | Default |
|-----------|------|---------|
| `limit` | `integer` | `80` (1…500) |
| `minNullFrac` | `number` | `0.5` (0…1) |

This is **not** a runtime “column read counter”; it is an **ANALYZE-based heuristic**.

---

### `pg_columns_not_in_any_index`

Columns of user tables that never appear in any index **`indkey`** (plain indexed attributes only; expression indexes are not resolved to column names).

| Parameter | Type | Default |
|-----------|------|---------|
| `limit` | `integer` | `200` (1…2000) |

---

### `pg_stat_statements_top`

Top normalized statements from **`pg_stat_statements`**. Requires the extension (see [PostgreSQL: permissions and extensions](#postgresql-permissions-and-extensions)).

Response fields **`total_time_ms`** and **`mean_time_ms`** map to `total_exec_time` / `mean_exec_time` on PostgreSQL 13+, and to `total_time` / `mean_time` on PostgreSQL 12.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sortBy` | see below | `"total_time"` | Sort key (descending) |
| `limit` | `integer` | `30` | 1…200 |
| `minCalls` | `integer` | `1` | `calls >= minCalls` |
| `queryContains` | `string?` | — | Substring match on `query` (`ILIKE`, `%` and `_` escaped) |
| `currentDatabaseOnly` | `boolean` | `true` | Restrict to current DB via `dbid` |
| `maxQueryChars` | `integer` | `4000` | Truncate returned `query` text (200…32000) |
| `includeInfo` | `boolean` | `false` | Include a row from `pg_stat_statements_info` when the view exists |

**`sortBy` values:** `total_time`, `mean_time`, `calls`, `rows`, `shared_blks_read`.

For **`mean_time`**, `minCalls: 1` is often noisy; try **`minCalls`** in the 5–20 range.

---

### `pg_scan_codebase_usage`

Recursively walks **`codebaseRoot`** (skips `node_modules`, `.git`, `dist`, etc.) and searches for **whole-word** identifiers: table names, column names, and qualified forms such as `schema.table`, `table.column`, and `schema.table.column`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `codebaseRoot` | `string` | **required** | Absolute path to the source tree |
| `schemas` | `string[]?` | — | Limit which schemas’ tables are considered |
| `maxTables` | `integer` | `120` | Max base tables analyzed |
| `maxColumnsPerTable` | `integer` | `40` | Max columns per table (by `information_schema` order) |
| `maxFiles` | `integer` | `8000` | Max files visited |

The response includes scan summary, sample matching lines, and **`possiblyNotReferencedInCode`**: identifiers with **zero** matches across the checked name variants.

---

## PostgreSQL: permissions and extensions

### Reading statistics views

For **`pg_stat_user_tables`**, **`pg_stats`**, and **`pg_stat_statements`**, the connecting role often needs **`pg_read_all_stats`** (or superuser). Permission errors are returned as JSON in the tool output.

### Enabling `pg_stat_statements`

1. In `postgresql.conf` (or via `ALTER SYSTEM`):

   ```text
   shared_preload_libraries = 'pg_stat_statements'
   ```

2. Restart the PostgreSQL instance.

3. In the target database:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

Without the extension, **`pg_stat_statements_top`** returns `ok: false` with guidance; **`pg_health`** reports `pg_stat_statements: false`.

---

## Testing without Cursor

Build and run the **stdio smoke test** (`initialize` → `tools/list` → `tools/call` on `pg_health`):

```bash
npm run build
npm run smoke
```

- If **`DATABASE_URL` is unset**, the smoke test expects `pg_health` to report a configuration error.
- If **`DATABASE_URL` is set** and the database is reachable, it expects `ok: true` from `pg_health`.

Script: `scripts/mcp-smoke.mjs`.

---

## Limitations

1. **`pg_stat_*`** reflects accumulated statistics since the last reset or instance start (and depends on stats collection settings).
2. PostgreSQL does **not** expose per-column “read counts” at the engine level in the same way as table-level stats; **`pg_column_stats_suspicious`** uses **planner statistics**, not application-level tracing.
3. **`pg_scan_codebase_usage`** misses names inside **dynamic SQL**, some **ORM** patterns without literal identifiers, generated files outside the walk, and may **false-positive** when SQL identifiers collide with common code words.
4. On Windows, escape backslashes in JSON (`\\`) or use forward slashes where your MCP client accepts them.

---

## Development

| Command | Purpose |
|---------|---------|
| `npm run dev` | Run `src/index.ts` with `tsx` (no prior build) |
| `npm run build` | Compile to `dist/` |
| `npm run start` | `node dist/index.js` |
| `npm run smoke` | MCP stdio smoke test |

Source layout:

| Path | Role |
|------|------|
| `src/index.ts` | MCP server and tool registration |
| `src/queries.ts` | PostgreSQL SQL |
| `src/codeScan.ts` | File walk and identifier search |
| `src/db.ts` | `pg` connection pool |
| `src/config.ts` | Reads `DATABASE_URL` |

---

## License

No `LICENSE` file is bundled yet; add one in the repository if you need an explicit terms of use.
