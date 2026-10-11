// Runs every test/*.test.js in its own plain `node` process and reports all
// failing files at the end (rather than stopping at the first), so one CI run
// shows everything that's broken on a platform. A Node script rather than a
// shell loop in package.json so `npm test` behaves the same on Windows
// (cmd.exe) as on macOS/Linux. (Not `node --test`: see harness.mjs for why.)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(`${f} (exit ${r.status ?? r.signal})`);
}
if (failed.length) {
  console.error(`\nFAILED: ${failed.join(", ")}`);
  process.exit(1);
}
