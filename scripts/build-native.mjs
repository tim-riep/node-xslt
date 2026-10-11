// Builds native/ (the cgo c-shared export layer) for the current GOOS/GOARCH
// (or whatever the caller has set them to, e.g. a CI build matrix) and writes
// it to dist/native/ under the name src/loader.ts expects: a Node
// platform/arch-named file (win32-x64, darwin-arm64, ...), not a Go
// GOOS/GOARCH-named one.
//
// Needs CGO_ENABLED=1 and a real C toolchain for the TARGET platform — cgo
// generally cannot cross-compile from a different host OS, so build each
// target on a native runner (see .github/workflows/_build.yml). Plain Node
// rather than bash so the same script runs on Windows runners too.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function goEnv(name) {
  const r = spawnSync("go", ["env", name], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`error: \`go env ${name}\` failed — is Go installed and on PATH?`);
    process.exit(1);
  }
  return r.stdout.trim();
}

const GOOS = goEnv("GOOS");
const GOARCH = goEnv("GOARCH");

const platform = { darwin: "darwin", linux: "linux", windows: "win32" }[GOOS];
const ext = { darwin: "dylib", linux: "so", windows: "dll" }[GOOS];
const arch = { arm64: "arm64", amd64: "x64" }[GOARCH];
if (!platform || !arch) {
  console.error(`error: unsupported GOOS/GOARCH ${GOOS}/${GOARCH}`);
  process.exit(1);
}

const outDir = path.join(root, "dist", "native");
const out = path.join(outDir, `goxslt-${platform}-${arch}.${ext}`);
mkdirSync(outDir, { recursive: true });

console.log(`==> go build -buildmode=c-shared (GOOS=${GOOS} GOARCH=${GOARCH} CGO_ENABLED=1)`);
const r = spawnSync(
  "go",
  ["build", "-buildmode=c-shared", "-ldflags=-s -w", "-o", out, "."],
  {
    cwd: path.join(root, "native"),
    env: { ...process.env, CGO_ENABLED: "1" },
    stdio: "inherit",
  },
);
if (r.status !== 0) process.exit(r.status ?? 1);

// c-shared also emits a .h header next to the library; not needed at runtime.
rmSync(out.slice(0, -ext.length) + "h", { force: true });

console.log(`==> wrote ${path.relative(root, out)} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
