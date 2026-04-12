import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  "vendor",
]);

const DEFAULT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".sql",
  ".prisma",
  ".java",
  ".kt",
  ".kts",
  ".go",
  ".rs",
  ".py",
  ".rb",
  ".cs",
]);

export type CodeHit = {
  file: string;
  line: number;
  snippet: string;
};

export type ScanSummary = {
  codebaseRoot: string;
  filesScanned: number;
  filesSkippedCap: boolean;
  hits: CodeHit[];
  /** Сколько раз идентификатор встретился как целое слово (по всем файлам). */
  matchCounts: Record<string, number>;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function walk(
  dir: string,
  maxFiles: number,
  skipNames: Set<string>,
  exts: Set<string>,
  out: string[]
): Promise<boolean> {
  let skippedCap = false;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (out.length >= maxFiles) {
      skippedCap = true;
      break;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipNames.has(ent.name)) continue;
      skippedCap = (await walk(full, maxFiles, skipNames, exts, out)) || skippedCap;
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!exts.has(ext)) continue;
    out.push(full);
  }
  return skippedCap;
}

function lineSnippet(line: string, maxLen = 200): string {
  const t = line.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

export async function scanCodebaseForIdentifiers(opts: {
  codebaseRoot: string;
  identifiers: string[];
  maxFiles?: number;
  extraSkipDirs?: string[];
  extraExtensions?: string[];
}): Promise<ScanSummary> {
  const maxFiles = opts.maxFiles ?? 8000;
  const skip = new Set(DEFAULT_SKIP);
  for (const s of opts.extraSkipDirs ?? []) skip.add(s);
  const exts = new Set(DEFAULT_EXT);
  for (const e of opts.extraExtensions ?? []) {
    const ext = e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`;
    exts.add(ext);
  }

  const root = path.resolve(opts.codebaseRoot);
  const files: string[] = [];
  const skippedCap = await walk(root, maxFiles, skip, exts, files);

  const needles = [...new Set(opts.identifiers.filter(Boolean))];
  const patterns = needles.map((id) => ({
    id,
    re: new RegExp(`\\b${escapeRegExp(id)}\\b`, "g"),
  }));

  const hits: CodeHit[] = [];
  const matchCounts: Record<string, number> = Object.create(null);
  for (const id of needles) matchCounts[id] = 0;
  const maxHits = 500;

  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      let lineMatched = false;
      for (const { id, re } of patterns) {
        let m = 0;
        re.lastIndex = 0;
        let exec: RegExpExecArray | null;
        while ((exec = re.exec(line))) {
          m += 1;
          if (m > 10_000) break;
        }
        if (m > 0) {
          matchCounts[id] = (matchCounts[id] ?? 0) + m;
          lineMatched = true;
        }
      }
      if (lineMatched && hits.length < maxHits) {
        hits.push({
          file: path.relative(root, file).replaceAll("\\", "/"),
          line: i + 1,
          snippet: lineSnippet(line),
        });
      }
    }
  }

  return {
    codebaseRoot: root,
    filesScanned: files.length,
    filesSkippedCap: skippedCap,
    hits,
    matchCounts,
  };
}
