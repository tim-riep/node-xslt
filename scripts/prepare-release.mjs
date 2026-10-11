// Release helpers for the per-platform packages (@tim-riep/node-xslt-<key>).
//
//   node scripts/prepare-release.mjs platform-packages <artifactsDir> <outDir> [--allow-partial]
//       Turns the native libraries CI built (found recursively under
//       artifactsDir) into one publishable package per platform in outDir.
//       Fails unless all six are present, unless --allow-partial.
//
//   node scripts/prepare-release.mjs placeholders <outDir>
//       Writes a placeholder (version 0.0.0, no library) package per
//       platform. npm only lets you configure Trusted Publishing on a
//       package that already exists, so each name has to be published once
//       by hand before the tag-triggered workflow can publish real versions
//       (see README, "One-time npm setup").
//
//   node scripts/prepare-release.mjs link-optional-deps
//       Adds all six platform packages to package.json's optionalDependencies
//       at exactly package.json's own version. Run by the release workflow
//       right before packing; deliberately not committed, so `npm ci` in
//       development never tries to resolve versions that aren't published.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const scope = "@tim-riep";

const PLATFORMS = [
  { key: "darwin-arm64", os: "darwin", cpu: "arm64", ext: "dylib" },
  { key: "darwin-x64", os: "darwin", cpu: "x64", ext: "dylib" },
  { key: "linux-arm64", os: "linux", cpu: "arm64", ext: "so" },
  { key: "linux-x64", os: "linux", cpu: "x64", ext: "so" },
  { key: "win32-arm64", os: "win32", cpu: "arm64", ext: "dll" },
  { key: "win32-x64", os: "win32", cpu: "x64", ext: "dll" },
];

const pkgName = (key) => `${scope}/node-xslt-${key}`;

function manifest(p, version, extra) {
  return {
    name: pkgName(p.key),
    version,
    description: `Native go-xslt library for ${rootPkg.name} on ${p.key}. Installed automatically as an optional dependency; not meant to be used directly.`,
    os: [p.os],
    cpu: [p.cpu],
    // The Linux libraries are built against glibc; npm skips them on musl.
    ...(p.os === "linux" ? { libc: ["glibc"] } : {}),
    license: rootPkg.license,
    repository: rootPkg.repository,
    publishConfig: { access: "public" },
    ...extra,
  };
}

function writePkg(dir, pkg) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

function findFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findFiles(full));
    else out.push(full);
  }
  return out;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "platform-packages") {
  const [artifactsDir, outDir] = args;
  const allowPartial = args.includes("--allow-partial");
  if (!artifactsDir || !outDir) usage();

  const found = new Map(findFiles(artifactsDir).map((f) => [path.basename(f), f]));
  const missing = [];
  rmSync(outDir, { recursive: true, force: true });
  for (const p of PLATFORMS) {
    const file = `goxslt-${p.key}.${p.ext}`;
    const src = found.get(file);
    if (!src) {
      missing.push(file);
      continue;
    }
    const dir = path.join(outDir, `node-xslt-${p.key}`);
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, path.join(dir, file));
    copyFileSync(path.join(root, "NOTICE"), path.join(dir, "NOTICE"));
    copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
    writePkg(dir, manifest(p, rootPkg.version, { files: [file, "NOTICE"] }));
    console.log(`${pkgName(p.key)}@${rootPkg.version}  (${file}, ${(statSync(src).size / 1048576).toFixed(1)} MB)`);
  }
  if (missing.length && !allowPartial) {
    console.error(`error: missing native libraries: ${missing.join(", ")}`);
    process.exit(1);
  }
} else if (cmd === "placeholders") {
  const [outDir] = args;
  if (!outDir) usage();
  rmSync(outDir, { recursive: true, force: true });
  for (const p of PLATFORMS) {
    const dir = path.join(outDir, `node-xslt-${p.key}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "README.md"),
      `# ${pkgName(p.key)}\n\nPlaceholder that reserves the package name so npm Trusted Publishing can be configured for it. Real versions are published by the release workflow of ${rootPkg.name}.\n`,
    );
    writePkg(dir, manifest(p, "0.0.0", { files: ["README.md"] }));
    console.log(`${pkgName(p.key)}@0.0.0  ->  ${dir}`);
  }
} else if (cmd === "link-optional-deps") {
  const optionalDependencies = Object.fromEntries(
    PLATFORMS.map((p) => [pkgName(p.key), rootPkg.version]),
  );
  rootPkg.optionalDependencies = optionalDependencies;
  writeFileSync(path.join(root, "package.json"), JSON.stringify(rootPkg, null, 2) + "\n");
  console.log(`optionalDependencies -> ${rootPkg.version}:`, Object.keys(optionalDependencies).join(", "));
} else {
  usage();
}

function usage() {
  console.error(
    "usage: prepare-release.mjs platform-packages <artifactsDir> <outDir> [--allow-partial]\n" +
      "       prepare-release.mjs placeholders <outDir>\n" +
      "       prepare-release.mjs link-optional-deps",
  );
  process.exit(2);
}
