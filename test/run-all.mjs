// Runs every test/*.test.js in its own plain `node` process, stopping at the
// first file that exits non-zero. A Node script rather than a shell loop in
// package.json so `npm test` behaves the same on Windows (cmd.exe) as on
// macOS/Linux. (Not `node --test`: see harness.mjs for why.)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${f} failed (exit ${r.status ?? r.signal})`);
    process.exit(1);
  }
}
