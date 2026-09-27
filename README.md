# node-xslt

XSLT 3.0 / XPath 3.1 / XSD 1.0–1.1 for Node.js — a Node package around the
[go-xslt](https://github.com/tim-riep/go-xslt) engine, compiled to
WebAssembly and run in-process (no native addon, no subprocess, no libxml2).

- Pure computation in, pure computation out: every call is `async`, takes a
  plain JSON-serializable request, and returns a plain result object. Errors
  are never thrown for engine-level problems (bad stylesheet, invalid XML,
  schema violations) — they come back as `diagnostics` on the result (see
  `hasErrors()`).
- Real filesystem access: `document()`/`doc()`, `xsl:include`/`xsl:import`,
  `xsl:result-document`, and `collection()` all work against the real
  filesystem via `baseDir`, exactly as in the Go library — the WASM module is
  wired up to Node's own `fs` module rather than an in-memory stub.
- One `.wasm` file ships in the package; nothing to compile or download at
  install time, and it runs the same on macOS/Linux/Windows/arm64/x64.

## Install

```sh
npm install node-xslt
```

## Usage

```ts
import { transform, evalXPath, validate, hasErrors } from "node-xslt";

const res = await transform({
  stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <greeting>Hello, <xsl:value-of select="/root/@name"/>!</greeting>
  </xsl:template>
</xsl:stylesheet>`,
  source: `<root name="World"/>`,
});

if (hasErrors(res)) {
  console.error(res.diagnostics);
} else {
  console.log(res.output); // <greeting>Hello, World!</greeting>
}
```

### `transform(req): Promise<TransformResult>`

Runs an XSLT 3.0 transformation.

```ts
interface TransformRequest {
  stylesheet: string;
  source?: string;
  params?: Record<string, string>;
  initialTemplate?: string;
  baseDir?: string; // enables disk-based document()/include/result-document/collection()
}
```

### `transformStream(req): { output: Readable; result: Promise<TransformStreamMeta> }`

Like `transform`, but delivers the result as a binary `Readable` (Buffer
chunks) instead of buffering it into one string — for results large enough
that holding the whole thing in memory, on either side of the WASM boundary,
matters. `output` applies real backpressure: if whatever it's piped to falls
behind, the engine itself pauses serializing until the consumer catches up.
`result` resolves once the transform finishes, with everything
`TransformResult` carries except `output` (`diagnostics`, `method`,
`messages`, `secondaryOutputs`, `durationMs`).

```ts
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { transformStream, hasErrors } from "node-xslt";

const { output, result } = transformStream({ stylesheet, source, baseDir });
await pipeline(output, createWriteStream("out.xml"));
const meta = await result;
if (hasErrors(meta)) console.error(meta.diagnostics);
```

As with the underlying engine's `TransformTo`, a run-phase error can occur
after some output has already gone out (e.g. a runtime error deep into a
large document); the diagnostic still arrives on `result`, and bytes already
emitted on `output` before that point are the caller's to discard.

### `evalXPath(req): Promise<XPathResult>`

Evaluates a standalone XPath 3.1 expression, with or without a context
document.

```ts
await evalXPath({ expression: "1 + 2" }); // value: "3"
await evalXPath({ expression: "/root/@name/string()", source: "<root name='x'/>" });
```

### `validate(req): Promise<ValidateResult>`

Validates an XML instance against one or more XSD 1.0/1.1 schemas.

```ts
await validate({
  schemas: [schemaText],
  instance: xmlText,
  version: "1.1", // default "1.0"
});
```

### `ready(): Promise<void>`

Pre-loads and instantiates the WASM engine, so the cost of reading and
compiling the ~15 MB module happens up front rather than on the first call.
Every function above lazily loads the engine on first use anyway.

### `hasErrors(result): boolean`

Shorthand for `result.diagnostics.some(d => d.severity === "error")`, mirroring
the Go engine's own `Result.HasErrors()`.

Full request/response shapes (including `Diagnostic`, `SecondaryOutput`,
`XPathItem`) are exported as TypeScript types — see `dist/index.d.ts`, or the
[go-xslt engine package](https://github.com/tim-riep/go-xslt/blob/main/engine/engine.go)
these mirror field-for-field.

## What isn't ported

This package doesn't reimplement any XSLT/XPath/XSD logic — it's a thin
bridge over the compiled Go engine (JSON in/out for `transform`/`validate`/
`evalXPath`; JSON in, raw bytes out for `transformStream`). Anything the
underlying `go-xslt` engine doesn't support, this package doesn't support
either; see that repository's README for XSLT/XPath/XSD conformance status.

## How it works

`go/` is a small Go program (a separate module, depending on
`github.com/tim-riep/go-xslt`) that registers three functions —
`transform`, `validate`, `evalXPath` — on `globalThis.__goXslt`, each taking
a JSON request string and returning a `Promise` that resolves to a JSON
response string. It's compiled with `GOOS=js GOARCH=wasm` and loaded in Node
via Go's own `wasm_exec.js` glue (vendored at build time from the local Go
toolchain, see `scripts/build-wasm.sh`).

Before loading that glue, the Node-side loader (`src/loader.ts`) sets
`globalThis.fs = require("node:fs")`. Go's `js/wasm` syscall layer already
expects a Node-`fs`-shaped object there for real file I/O — the callback
signatures line up exactly — so this one assignment is what gives
`document()`/`xsl:include`/`xsl:result-document`/`collection()` real disk
access instead of failing with `ENOSYS`.

Each exported Go function runs its actual work on a **new goroutine**,
returning a JS `Promise` immediately rather than blocking synchronously.
This matters specifically because of that real file I/O: Go's `js/wasm`
target can only suspend a goroutine and hand control back to Node's event
loop (so a pending `fs.read`/`fs.open` callback can actually fire) when that
goroutine isn't sitting on the same synchronous JS→Go call stack that
invoked it. A synchronous `js.FuncOf` callback that itself blocks on file I/O
deadlocks; a `go func() { ...; resolve(...) }()` launched from inside that
callback does not.

`transformStream` reuses that same mechanism for backpressure. On the Go
side, `TransformTo` writes through a small `io.Writer` that hands each write
to Node as a `Uint8Array` (never a per-chunk string — a write boundary isn't
guaranteed to land on a UTF-8 character boundary, so decoding per chunk could
split a multi-byte character across two writes; the byte stream is decoded
whole on the JS side instead). That callback may return a JS `Promise`, and
the Go side blocks on it before returning from `Write`. The Node wrapper
returns that promise exactly when `Readable#push()` reports backpressure and
resolves it only once `_read()` is called again — so a slow consumer (a slow
disk, a throttled HTTP response) propagates all the way back into the Go
serializer, which genuinely pauses instead of buffering unboundedly on
either side of the WASM boundary.

## Building from source

Requires Go ≥ 1.25 and Node ≥ 20.

```sh
npm install
npm run build   # tsup (TS -> dist/index.{js,cjs,d.ts}) + go build -> dist/wasm/*
npm test
```

`scripts/build-wasm.sh` copies `wasm_exec.js` from whichever Go toolchain is
on `PATH` at build time — its import-object shape must match the Go version
that produced `go-xslt.wasm`, so always run `npm run build` (not the two
halves against toolchains of different versions) when bumping the Go
version.

## CI/CD

- **`.github/workflows/ci.yml`** — on every push to `main` and every PR:
  type-checks, builds and runs the test suite, on both Linux and macOS
  across Node 20 and 22 (a 2×2 matrix), so a regression surfaces before it
  reaches a release tag.
- **`.github/workflows/release.yml`** — on every pushed tag matching `v*`:
  verifies the tag matches `package.json`'s `version`, builds, tests,
  `npm publish`es, and creates a GitHub release with the built tarball
  attached.

```sh
# 1. bump "version" in package.json to match the tag you're about to push
npm version 0.2.0 --no-git-tag-version
git commit -am "release v0.2.0"
git push

# 2. tag and push — this triggers the release workflow
git tag v0.2.0
git push origin v0.2.0
```

Publishing uses npm's **trusted publishing** (OIDC) rather than a long-lived
`NPM_TOKEN` secret: the workflow gets `id-token: write` permission, and the
npm CLI (pinned to `>=11.5.1` in the workflow — the minimum that supports
this) exchanges GitHub's OIDC token for a short-lived npm auth token at
publish time. Provenance attestations come along automatically as part of
that same exchange.

One-time setup on npmjs.com, in the package's Settings → **Trusted
Publisher**: add a GitHub Actions publisher naming this repository and the
workflow filename `release.yml`. This has to be done through the package's
own settings page, which means it needs the package to already exist — for
the very first release of a brand-new package, publish once manually first
(`npm login && npm publish --access public` from a local checkout after
`npm run build`), configure the trusted publisher on the now-existing
package, and every release after that goes through the tag-triggered
workflow with no token at all.

## License

Apache-2.0, see [LICENSE](./LICENSE). This package bundles a compiled build
of [go-xslt](https://github.com/tim-riep/go-xslt) (Apache-2.0) and Go's
`wasm_exec.js` glue (BSD-3-Clause) — see [NOTICE](./NOTICE).
