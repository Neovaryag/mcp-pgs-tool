# mcp-pgs-tool

MCP-сервер (Model Context Protocol) на **TypeScript** для **PostgreSQL**.  
Проект даёт инструменты для анализа схемы и активности БД, поиска потенциально «холодных» таблиц/колонок, проверки покрытия индексами, анализа `pg_stat_statements`, а также грубого поиска использования таблиц и колонок в локальном коде.

Транспорт: **stdio** (одна строка = один JSON-RPC пакет).

---

## Содержание

- [Возможности](#возможности)
- [Требования](#требования)
- [Установка и сборка](#установка-и-сборка)
- [Подключение MCP в Cursor](#подключение-mcp-в-cursor)
- [Подключение MCP в GigaCode CLI](#подключение-mcp-в-gigacode-cli)
- [Переменные окружения](#переменные-окружения)
- [Инструменты (tools)](#инструменты-tools)
- [Безопасность использования](#безопасность-использования)
- [Права PostgreSQL и расширения](#права-postgresql-и-расширения)
- [Проверка работы (smoke test)](#проверка-работы-smoke-test)
- [Ограничения и интерпретация результатов](#ограничения-и-интерпретация-результатов)
- [Разработка](#разработка)

---

## Возможности

- Получение схем, таблиц и колонок из `information_schema`.
- Статистика активности таблиц из `pg_stat_user_tables`.
- Эвристика «подозрительных/малополезных» колонок по `pg_stats`.
- Поиск колонок, которые не входят ни в один индекс.
- Топ SQL-запросов из `pg_stat_statements`.
- Скан локального репозитория на упоминания таблиц/колонок.
- Встроенная защита:
  - только read-only SQL (на уровне runtime-политики),
  - маскирование чувствительных данных в ответах.

---

## Требования

| Компонент | Версия |
|-----------|--------|
| Node.js | **>= 20** |
| PostgreSQL | рекомендуется **12+** |

---

## Установка и сборка

```bash
git clone <URL_репозитория>
cd mcp-pgs-tool
npm install
npm run build
```

После сборки основной entrypoint: `dist/index.js`.

Также есть корневой `index.js` (shim), который подгружает `dist/index.js`.

---

## Подключение MCP в Cursor

Отредактируйте файл `~/.cursor/mcp.json` (на Windows: `C:\Users\<user>\.cursor\mcp.json`) и добавьте сервер.

Пример для Windows:

```json
{
  "mcpServers": {
    "mcp-pgs-tool": {
      "command": "node",
      "args": [
        "C:/Users/<USER>/IdeaProjects/mcp-pgs-tool/dist/index.js"
      ],
      "env": {
        "DATABASE_URL": "postgresql://DB_USER:DB_PASSWORD@HOST:5432/DB_NAME"
      }
    }
  }
}
```

Важно:

- Путь должен указывать на **существующий** файл (`dist/index.js` или корневой `index.js`).
- После изменения конфига перезапустите MCP/IDE.
- Если используете корневой `index.js`, проект должен быть собран (`npm run build`), иначе shim завершится ошибкой.

---

## Подключение MCP в GigaCode CLI

Для GigaCode CLI добавьте сервер в файл проекта:

- `.gigacode/settings.json`

Пример конфигурации:

```json
{
  "mcpServers": {
    "mcp-pgs-tool": {
      "command": "node",
      "args": [
        "C:/Users/<USER>/IdeaProjects/mcp-pgs-tool/index.js"
      ],
      "env": {
        "DATABASE_URL": "postgresql://DB_USER:DB_PASSWORD@HOST:5432/DB_NAME"
      }
    }
  }
}
```

Рекомендации:

- Убедитесь, что выполнен `npm run build` и существует `dist/index.js`.
- Корневой `index.js` — это shim, он подгружает `dist/index.js` после сборки.
- Если у GigaCode CLI есть команда перезагрузки MCP-конфигурации, выполните её после изменения файла.
- Не храните реальные пароли в открытом репозитории; используйте локальный конфиг или секреты среды.

---

## Переменные окружения

| Переменная | Обязательность | Назначение |
|------------|----------------|-----------|
| `DATABASE_URL` | Да | PostgreSQL URI для подключения |

Пример:

```text
postgresql://user:password@localhost:5432/mydb
```

Если `DATABASE_URL` не задан, сервер стартует, но DB-инструменты вернут ошибку.

---

## Инструменты (tools)

### `pg_health`
Проверка подключения к БД:
- версия PostgreSQL,
- текущая БД,
- наличие расширения `pg_stat_statements`.

### `pg_list_schemas`
Список пользовательских схем (без системных).

### `pg_list_tables`
Список таблиц/представлений:
- схема,
- имя,
- тип,
- оценка числа строк (`reltuples`).

Параметры:
- `schemas?: string[]` — фильтр по схемам.

### `pg_list_columns`
Список колонок:
- имя таблицы/схемы,
- имя колонки,
- тип,
- nullable,
- default.

Параметры:
- `schema?: string`
- `table?: string`

### `pg_table_activity`
Активность таблиц из `pg_stat_user_tables`:
- `seq_scan`, `idx_scan`,
- `n_tup_ins`, `n_tup_upd`, `n_tup_del`,
- `seq_tup_read`, `idx_tup_fetch`,
- даты vacuum/analyze.

Параметры:
- `order: "hot" | "cold"` (по умолчанию `"cold"`)
- `limit: number` (1..500)

### `pg_column_stats_suspicious`
Эвристика по `pg_stats`:
- `null_frac`,
- `n_distinct`,
- `correlation`,
- `most_common_vals`.

Параметры:
- `limit: number` (1..500)
- `minNullFrac: number` (0..1)

### `pg_columns_not_in_any_index`
Колонки пользовательских таблиц, которые не входят ни в один индекс.

Параметры:
- `limit: number` (1..2000)

### `pg_stat_statements_top`
Топ запросов из `pg_stat_statements`.

Параметры:
- `sortBy`: `total_time | mean_time | calls | rows | shared_blks_read`
- `limit`: 1..200
- `minCalls`
- `queryContains?`
- `currentDatabaseOnly`
- `maxQueryChars`
- `includeInfo`

Примечание по времени:
- PostgreSQL 13+: `total_exec_time` / `mean_exec_time`
- PostgreSQL 12: `total_time` / `mean_time`

### `pg_scan_codebase_usage`
Сканирует локальный код по `codebaseRoot` и ищет целые слова:
- имя таблицы,
- `schema.table`,
- имя колонки,
- `table.column`,
- `schema.table.column`.

Параметры:
- `codebaseRoot` (обязателен)
- `schemas?`
- `maxTables`
- `maxColumnsPerTable`
- `maxFiles`

Выход:
- summary скана,
- sample hit-строки,
- `possiblyNotReferencedInCode` (кандидаты «не найдено в коде»).

---

## Безопасность использования

В проекте реализованы 2 уровня защиты.

### 1) Read-only политика SQL

Все запросы проходят через `safeQuery()` в `src/db.ts`.

Разрешено только:
- `SELECT`
- `WITH`
- `SHOW`
- `EXPLAIN`

Блокируется:
- DML/DDL/управляющие операции (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `GRANT`, `SET`, `COPY`, и т.д.),
- multi-statement SQL (например, `SELECT ...; DELETE ...`).

Итог: инструменты MCP в этом сервере **не могут менять данные** в БД.

### 2) Маскирование чувствительных данных

Перед возвратом ответа клиенту выполняется санитизация (`src/index.ts`):

- По ключам полей (например: `password`, `token`, `secret`, `card`, `account`, `email`, `phone`) значения редактируются в `"[redacted]"`.
- В строках маскируются шаблоны:
  - email -> `***@***`
  - телефон -> `[masked-phone]`
  - номер карты (с проверкой Luhn) -> `[masked-card]`

Это уменьшает риск утечки PII/финансовых данных в ответах tools.

---

## Права PostgreSQL и расширения

Для некоторых статистических представлений нужны повышенные права (часто `pg_read_all_stats`).

Для `pg_stat_statements_top` нужно:

1. Включить расширение в preload:

```text
shared_preload_libraries = 'pg_stat_statements'
```

2. Перезапустить PostgreSQL.
3. Выполнить в нужной БД:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

---

## Проверка работы (smoke test)

```bash
npm run build
npm run smoke
```

Скрипт: `scripts/mcp-smoke.mjs`.

Проверяет:
- MCP handshake (`initialize`),
- `tools/list`,
- вызов `pg_health`.

---

## Ограничения и интерпретация результатов

1. Метрики `pg_stat_*` накопительные (с момента старта/сброса статистики).
2. В PostgreSQL нет прямого универсального счётчика «сколько раз читали конкретную колонку»; `pg_column_stats_suspicious` — это эвристика.
3. `pg_scan_codebase_usage` может:
   - пропускать динамический SQL/ORM-построение,
   - давать ложные совпадения по похожим словам.
4. Маскирование в ответах снижает риски, но не заменяет полноценную DLP/политику доступа на стороне БД и инфраструктуры.

---

## Разработка

| Команда | Назначение |
|---------|------------|
| `npm run dev` | запуск `src/index.ts` через `tsx` |
| `npm run build` | компиляция в `dist/` |
| `npm run start` | запуск `node dist/index.js` |
| `npm run smoke` | smoke-проверка MCP |

Структура:

| Путь | Роль |
|------|------|
| `src/index.ts` | MCP сервер и маршрутизация tools |
| `src/queries.ts` | SQL-запросы к PostgreSQL |
| `src/db.ts` | пул подключений + read-only guard |
| `src/codeScan.ts` | скан исходников на упоминания идентификаторов |
| `src/config.ts` | чтение `DATABASE_URL` |
| `scripts/mcp-smoke.mjs` | локальный smoke-test |

