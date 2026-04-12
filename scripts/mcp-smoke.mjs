import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const entry = path.join(root, "dist", "index.js");

function send(proc, obj) {
  proc.stdin.write(`${JSON.stringify(obj)}\n`);
}

function main() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [entry], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });

    const pending = new Map();
    let lineBuf = "";

    proc.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const parts = lineBuf.split("\n");
      lineBuf = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          reject(new Error(`Non-JSON line: ${line.slice(0, 200)}`));
          return;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });

    function request(id, method, params) {
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 15_000);
        pending.set(id, (msg) => {
          clearTimeout(t);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        });
        send(proc, { jsonrpc: "2.0", id, method, params });
      });
    }

    proc.on("error", reject);

    (async () => {
      try {
        const init = await request(1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-smoke", version: "0.0.1" },
        });
        if (!init?.serverInfo?.name) {
          throw new Error(`initialize: unexpected ${JSON.stringify(init).slice(0, 300)}`);
        }

        send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

        const list = await request(2, "tools/list", {});
        const names = (list.tools ?? []).map((t) => t.name);
        const required = [
          "pg_health",
          "pg_stat_statements_top",
          "pg_list_schemas",
          "pg_scan_codebase_usage",
        ];
        for (const n of required) {
          if (!names.includes(n)) throw new Error(`missing tool ${n}, got: ${names.join(", ")}`);
        }

        const health = await request(3, "tools/call", {
          name: "pg_health",
          arguments: {},
        });
        const text = health?.content?.[0]?.text;
        if (!text) throw new Error(`tools/call pg_health: ${JSON.stringify(health)}`);
        const parsed = JSON.parse(text);
        if (!process.env.DATABASE_URL?.trim()) {
          if (parsed.ok !== false) {
            throw new Error(`expected DATABASE_URL missing error, got ${text.slice(0, 400)}`);
          }
        } else if (parsed.ok !== true) {
          throw new Error(`pg_health failed: ${text.slice(0, 800)}`);
        }

        proc.stdin.end();
        await new Promise((r) => setTimeout(r, 150));
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve({ tools: names.length, stderr: stderr.trim() });
      } catch (e) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        reject(e);
      }
    })();
  });
}

main()
  .then(({ tools, stderr }) => {
    console.log(`OK: MCP handshake + tools/list (${tools} tools)`);
    if (stderr) console.warn("stderr:", stderr);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
