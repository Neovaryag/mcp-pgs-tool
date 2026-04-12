#!/usr/bin/env node
/**
 * Entry shim for MCP clients that point at the repo root (…/mcp-pgs-tool/index.js).
 * The compiled server lives in dist/index.js — run `npm run build` first.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(root, "dist", "index.js");

if (!existsSync(distEntry)) {
  console.error(
    "mcp-pgs-tool: dist/index.js not found. From the project root run: npm install && npm run build"
  );
  process.exit(1);
}

await import(pathToFileURL(distEntry).href);
