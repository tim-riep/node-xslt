// Fails unless dist/native holds the native library for every supported
// platform. Wired up as `prepublishOnly`, so a publish from anywhere that
// hasn't gathered all six (a development checkout has only its own) refuses
// instead of shipping a package that fails to load on the missing platforms.
// The release workflow downloads the six CI-built artifacts into dist/native
// first; it publishes with the scripts enabled so this runs there too.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2] ?? path.join(root, "dist", "native");

const expected = [
  "darwin-arm64.dylib",
  "darwin-x64.dylib",
  "linux-arm64.so",
  "linux-x64.so",
  "win32-arm64.dll",
  "win32-x64.dll",
].map((f) => `goxslt-${f}`);

const missing = expected.filter((f) => !existsSync(path.join(dir, f)));
if (missing.length) {
  console.error(`error: ${dir} is missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`all ${expected.length} native libraries present in ${dir}`);
