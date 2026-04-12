#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDatabaseUrl } from "./config.js";
import { createPool, withClient } from "./db.js";
import { scanCodebaseForIdentifiers } from "./codeScan.js";
import {
  columnStatistics,
  columnsNotInAnyIndex,
  getServerInfo,
  hasPgStatStatements,
  listColumns,
  listColumnsForTables,
  listSchemas,
  listTables,
  pgStatStatementsInfo,
  pgStatStatementsTop,
  tableStatistics,
} from "./queries.js";

const ListTablesInput = z.object({
  schemas: z.array(z.string()).optional().describe("Filter by schema names"),
});

const ListColumnsInput = z.object({
  schema: z.string().optional(),
  table: z.string().optional(),
});

const TableActivityInput = z.object({
  order: z.enum(["hot", "cold"]).default("cold"),
  limit: z.number().int().min(1).max(500).default(50),
});

const ColumnStatsInput = z.object({
  limit: z.number().int().min(1).max(500).default(80),
  minNullFrac: z.number().min(0).max(1).default(0.5),
});

const UnindexedColumnsInput = z.object({
  limit: z.number().int().min(1).max(2000).default(200),
});

const ScanCodeInput = z.object({
  codebaseRoot: z.string().min(1),
  schemas: z.array(z.string()).optional(),
  maxTables: z.number().int().min(1).max(500).default(120),
  maxColumnsPerTable: z.number().int().min(1).max(200).default(40),
  maxFiles: z.number().int().min(100).max(50_000).default(8000),
});

const HealthInput = z.object({}).optional();

const StatStatementsInput = z.object({
  sortBy: z
    .enum(["total_time", "mean_time", "calls", "rows", "shared_blks_read"])
    .default("total_time"),
  limit: z.number().int().min(1).max(200).default(30),
  minCalls: z.number().int().min(1).max(1_000_000_000).default(1),
  queryContains: z.string().max(500).optional(),
  currentDatabaseOnly: z.boolean().default(true),
  maxQueryChars: z.number().int().min(200).max(32_000).default(4000),
  includeInfo: z
    .boolean()
    .default(false)
    .describe("Добавить строку из pg_stat_statements_info, если представление есть"),
});

function requirePool() {
  const url = getDatabaseUrl();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Set it in the environment for the MCP server process."
    );
  }
  return createPool(url);
}

let pool = getDatabaseUrl() ? createPool(getDatabaseUrl()!) : null;

function jsonText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new Server(
  { name: "mcp-pgs-tool", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pg_health",
      description:
        "Проверка подключения к PostgreSQL: версия, имя БД, наличие расширения pg_stat_statements.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "pg_list_schemas",
      description: "Список пользовательских схем (кроме pg_catalog / information_schema).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "pg_list_tables",
      description:
        "Таблицы и представления: схема, имя, тип, оценка числа строк (reltuples).",
      inputSchema: {
        type: "object",
        properties: {
          schemas: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pg_list_columns",
      description: "Колонки из information_schema (тип, nullable, default).",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pg_table_activity",
      description:
        "Активность таблиц из pg_stat_user_tables: seq/idx scan, tuple ops, reads/fetches. order=cold — «непопулярные» (низкая суммарная активность).",
      inputSchema: {
        type: "object",
        properties: {
          order: { type: "string", enum: ["hot", "cold"], default: "cold" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pg_column_stats_suspicious",
      description:
        "Статистика планировщика (pg_stats): высокая null_frac и низкая кардинальность — кандидаты на «непопулярные» или малоиспользуемые колонки (эвристика, не метрика чтений).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, default: 80 },
          minNullFrac: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pg_columns_not_in_any_index",
      description:
        "Колонки таблиц, не входящие ни в один индекс (включая составные; выражения в индексах не учитываются как имена колонок).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pg_stat_statements_top",
      description:
        "Топ запросов из pg_stat_statements (нужно расширение в БД). Сортировка по суммарному/среднему времени, вызовам, строкам или shared_blks_read. Время в мс. Поддерживаются PG12 (total_time) и PG13+ (total_exec_time).",
      inputSchema: {
        type: "object",
        properties: {
          sortBy: {
            type: "string",
            enum: ["total_time", "mean_time", "calls", "rows", "shared_blks_read"],
            default: "total_time",
          },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 30 },
          minCalls: { type: "integer", minimum: 1, maximum: 1000000000, default: 1 },
          queryContains: { type: "string", maxLength: 500 },
          currentDatabaseOnly: { type: "boolean", default: true },
          maxQueryChars: { type: "integer", minimum: 200, maximum: 32000, default: 4000 },
          includeInfo: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pg_scan_codebase_usage",
      description:
        "Поиск в коде целых слов (table, column, schema.table). Грубая эвристика: не видит динамический SQL и ORM без явных имён. Укажите абсолютный путь codebaseRoot.",
      inputSchema: {
        type: "object",
        required: ["codebaseRoot"],
        properties: {
          codebaseRoot: { type: "string" },
          schemas: { type: "array", items: { type: "string" } },
          maxTables: { type: "integer", minimum: 1, maximum: 500, default: 120 },
          maxColumnsPerTable: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 40,
          },
          maxFiles: { type: "integer", minimum: 100, maximum: 50000, default: 8000 },
        },
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  const ensurePool = () => {
    if (!pool) {
      pool = requirePool();
    }
    return pool;
  };

  try {
    if (name === "pg_health") {
      HealthInput.parse(args);
      const p = ensurePool();
      const info = await withClient(p, async (c) => {
        const base = await getServerInfo(c);
        const ext = await hasPgStatStatements(c);
        return { ...base, pg_stat_statements: ext };
      });
      return jsonText({
        ok: true,
        note: "Статистика pg_stat_* накапливается с момента последнего сброса/старта кластера.",
        ...info,
      });
    }

    if (name === "pg_list_schemas") {
      const p = ensurePool();
      const rows = await withClient(p, (c) => listSchemas(c));
      return jsonText({ schemas: rows });
    }

    if (name === "pg_list_tables") {
      const input = ListTablesInput.parse(args);
      const p = ensurePool();
      const rows = await withClient(p, (c) => listTables(c, { schemas: input.schemas }));
      return jsonText({ tables: rows });
    }

    if (name === "pg_list_columns") {
      const input = ListColumnsInput.parse(args);
      const p = ensurePool();
      const rows = await withClient(p, (c) =>
        listColumns(c, { schema: input.schema, table: input.table })
      );
      return jsonText({ columns: rows });
    }

    if (name === "pg_table_activity") {
      const input = TableActivityInput.parse(args);
      const p = ensurePool();
      const rows = await withClient(p, (c) =>
        tableStatistics(c, { order: input.order, limit: input.limit })
      );
      return jsonText({ order: input.order, tables: rows });
    }

    if (name === "pg_column_stats_suspicious") {
      const input = ColumnStatsInput.parse(args);
      const p = ensurePool();
      const rows = await withClient(p, (c) =>
        columnStatistics(c, { limit: input.limit, minNullFrac: input.minNullFrac })
      );
      return jsonText({
        heuristic:
          "Высокая null_frac и низкая |n_distinct| часто означают «пустые» или почти константные колонки; это не доказывает отсутствие обращений из приложения.",
        columns: rows,
      });
    }

    if (name === "pg_columns_not_in_any_index") {
      const input = UnindexedColumnsInput.parse(args);
      const p = ensurePool();
      const rows = await withClient(p, (c) => columnsNotInAnyIndex(c, { limit: input.limit }));
      return jsonText({ columns: rows });
    }

    if (name === "pg_stat_statements_top") {
      const input = StatStatementsInput.parse(args);
      const p = ensurePool();
      const rows = await withClient(p, async (c) => {
        const installed = await hasPgStatStatements(c);
        if (!installed) {
          return {
            ok: false as const,
            error:
              "Расширение pg_stat_statements не установлено. Выполните CREATE EXTENSION pg_stat_statements; и добавьте pg_stat_statements в shared_preload_libraries с перезапуском кластера.",
          };
        }
        const statements = await pgStatStatementsTop(c, {
          sortBy: input.sortBy,
          limit: input.limit,
          minCalls: input.minCalls,
          queryContains: input.queryContains,
          currentDatabaseOnly: input.currentDatabaseOnly,
          maxQueryChars: input.maxQueryChars,
        });
        const info =
          input.includeInfo ? await pgStatStatementsInfo(c) : undefined;
        return {
          ok: true as const,
          sortBy: input.sortBy,
          note:
            "Поля total_time_ms / mean_time_ms соответствуют total_exec_time/mean_exec_time (PG13+) или total_time/mean_time (PG12). Для mean_time при малых calls результат шумный — поднимите minCalls.",
          statements,
          ...(info !== undefined && info !== null ? { info } : {}),
        };
      });
      return jsonText(rows);
    }

    if (name === "pg_scan_codebase_usage") {
      const input = ScanCodeInput.parse(args);
      const p = ensurePool();
      const tables = await withClient(p, (c) =>
        listTables(c, { schemas: input.schemas })
      );
      const baseTables = tables
        .filter((t) => t.table_type === "BASE TABLE")
        .slice(0, input.maxTables);

      const identifiers = new Set<string>();
      for (const t of baseTables) {
        identifiers.add(t.table_name);
        identifiers.add(`${t.table_schema}.${t.table_name}`);
      }

      const allCols = await withClient(p, (c) =>
        listColumnsForTables(
          c,
          baseTables.map((t) => ({ schema: t.table_schema, name: t.table_name }))
        )
      );
      const colsLimited = new Map<string, number>();
      for (const col of allCols) {
        const key = `${col.table_schema}.${col.table_name}`;
        const n = colsLimited.get(key) ?? 0;
        if (n >= input.maxColumnsPerTable) continue;
        colsLimited.set(key, n + 1);
        identifiers.add(col.column_name);
        identifiers.add(`${col.table_name}.${col.column_name}`);
        identifiers.add(`${col.table_schema}.${col.table_name}.${col.column_name}`);
      }

      const scan = await scanCodebaseForIdentifiers({
        codebaseRoot: input.codebaseRoot,
        identifiers: [...identifiers],
        maxFiles: input.maxFiles,
      });

      const counts = scan.matchCounts;
      const unusedCandidates: { kind: "table" | "column"; qualified: string }[] = [];

      for (const t of baseTables) {
        const qualifiedTable = `${t.table_schema}.${t.table_name}`;
        const hitsTable =
          (counts[t.table_name] ?? 0) + (counts[qualifiedTable] ?? 0);
        if (hitsTable === 0) {
          unusedCandidates.push({ kind: "table", qualified: qualifiedTable });
        }
      }

      colsLimited.clear();
      for (const col of allCols) {
        const key = `${col.table_schema}.${col.table_name}`;
        const n = colsLimited.get(key) ?? 0;
        if (n >= input.maxColumnsPerTable) continue;
        colsLimited.set(key, n + 1);

        const qualified = `${col.table_schema}.${col.table_name}.${col.column_name}`;
        const hitsCol =
          (counts[col.column_name] ?? 0) +
          (counts[`${col.table_name}.${col.column_name}`] ?? 0) +
          (counts[qualified] ?? 0);
        if (hitsCol === 0) {
          unusedCandidates.push({ kind: "column", qualified });
        }
      }

      return jsonText({
        scanSummary: {
          codebaseRoot: scan.codebaseRoot,
          filesScanned: scan.filesScanned,
          filesSkippedCap: scan.filesSkippedCap,
          sampleHitLines: scan.hits.length,
        },
        sampleHits: scan.hits.slice(0, 80),
        possiblyNotReferencedInCode: unusedCandidates.slice(0, 500),
        limits: {
          maxTables: input.maxTables,
          maxColumnsPerTable: input.maxColumnsPerTable,
        },
      });
    }

    return jsonText({ error: `Unknown tool: ${name}` });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonText({ ok: false, error: message });
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
