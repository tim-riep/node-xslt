# @tim-riep/node-xslt

XSLT 3.0 / XPath 3.1 / XSD 1.0–1.1 for Node.js — a Node package around the
[go-xslt](https://github.com/tim-riep/go-xslt) engine, built as a native
addon: the Go library compiled to a C shared library
(`-buildmode=c-shared`), called from Node via [koffi](https://koffi.dev)
(FFI, no node-gyp/C++ glue to build or ship) inside a small pool of real
child processes.

- Pure computation in, pure computation out: every call is `async`, takes a
  plain JSON-serializable request, and returns a plain result object. Errors
  are never thrown for engine-level problems (bad stylesheet, invalid XML,
  schema violations) — they come back as `diagnostics` on the result (see
  `hasErrors()`).
- Real filesystem access: `document()`/`doc()`, `xsl:include`/`xsl:import`,
  `xsl:result-document`, and `collection()` all work against the real
  filesystem via `baseDir`, exactly as in the Go library — it's ordinary
  native Go code, not a sandboxed runtime.
- Memory is actually released between calls. An earlier WebAssembly build of
  this package didn't: WASM linear memory can only grow for the life of the
  process, so repeated large transforms in one long-lived process meant
  unbounded (eventually crashing) memory growth. This native build runs as
  ordinary compiled Go in a real OS process — Go's own scavenger returns
  freed heap pages to the OS the normal way. See
  [How it works](#how-it-works) for what that's built on.
- Real concurrency: each call in the pool runs on its own OS process, not a
  single-threaded interpreter — multiple transforms genuinely run in
  parallel.

## Install

```sh
npm install @tim-riep/node-xslt
```

Requires a native build of `native/` for your platform (see
[Building from source](#building-from-source)) — this repository does not
yet publish prebuilt binaries for every platform; see
[Platform support](#platform-support).

## Usage

```ts
import { transform, evalXPath, validate, hasErrors } from "@tim-riep/node-xslt";

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
that holding the whole thing in memory matters. `output` applies real
backpressure: if whatever it's piped to falls behind, the engine itself
pauses serializing until the consumer catches up. `result` resolves once the
transform finishes, with everything `TransformResult` carries except
`output` (`diagnostics`, `method`, `messages`, `secondaryOutputs`,
`durationMs`).

```ts
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { transformStream, hasErrors } from "@tim-riep/node-xslt";

const { output, result } = transformStream({ stylesheet, source, baseDir });
await pipeline(output, createWriteStream("out.xml"));
const meta = await result;
if (hasErrors(meta)) console.error(meta.diagnostics);
```

As with the underlying engine's `TransformTo`, a run-phase error can occur
after some output has already gone out (e.g. a runtime error deep into a
large document); the diagnostic still arrives on `result` (never a
rejection — destroying `output` early behaves the same way), and bytes
already emitted on `output` before that point are the caller's to discard.

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

Pre-loads the child-process pool, so that startup cost happens up front
rather than on the first call. Every function above lazily loads it on
first use anyway.

### `close(): Promise<void>`

Terminates the pool's child processes. Not needed for normal use — pool
children are unref'd and never keep a process alive on their own, and a
script or server can just exit normally — but useful when something wants
deterministic, immediate shutdown instead (a short-lived CLI, a test suite).

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
`evalXPath`; raw bytes for `transformStream`'s chunks). Anything the
underlying `go-xslt` engine doesn't support, this package doesn't support
either; see that repository's README for XSLT/XPath/XSD conformance status.

## Platform support

`native/` builds one shared library per platform+arch (a `.dylib`, `.so` or
`.dll`), and the loader (`src/loader.ts`) picks
`dist/native/goxslt-<platform>-<arch>.<ext>` at runtime based on
`process.platform`/`process.arch`. Right now this repository only builds and
ships `darwin-arm64` from local development; a real release needs a build
matrix (one native runner per target — cgo generally can't cross-compile
from a different host OS) producing the rest (`darwin-x64`, `linux-x64`,
`linux-arm64`, `win32-x64`) and bundling or distributing them (e.g. as
per-platform `optionalDependencies`, the way `esbuild` does it). That CI
work is a known gap, not yet done.

## How it works

`native/` is a small Go program (a separate module, depending on
`github.com/tim-riep/go-xslt`) built with `go build -buildmode=c-shared`,
exporting a plain C ABI: `Transform`/`Validate`/`EvalXPath` (JSON string in,
JSON string out, freed by the caller via an exported `Free`), and a
streaming counterpart for `TransformTo` — `TransformToStart`/`Next`/
`Result`/`Free` — described below. The Go library itself stays cgo-free;
only this thin export wrapper needs it.

On the Node side, each pool worker (`src/child.ts`) is a real
**child_process**, not a `worker_threads.Worker`, and every koffi call in it
is **synchronous**, never `.func.async()`. Both of those are load-bearing,
found the hard way:

- koffi's own `.func.async()` leaves its internal worker-pool threads
  spinning at close to 100% CPU per thread indefinitely after the call
  completes — reproduced with nothing but one async call against this
  library, no pool or streaming involved.
- Loading this same native library inside a `worker_thread` — even calling
  it purely synchronously, even after `unref()`-ing the worker — leaves the
  process unable to exit on its own. Reproduced with nothing but
  `koffi.load()` + one sync call in a worker and no code of ours involved;
  the identical script run as a real child process exits cleanly in well
  under a second.

So: every call is synchronous, and always runs inside a forked child
process, dispatched from `src/loader.ts`'s small pool over that child's IPC
channel (`process.send`/`process.on('message')`).

One more thing had to be right for the pool to actually let Node exit
naturally when idle: **`child.unref()` alone doesn't cover the IPC channel.**
`ChildProcess#unref()`/`#ref()` toggle whether the *process handle* counts
toward keeping the event loop alive; the IPC channel underlying
`send()`/`on('message')` is a *separate* handle (`child.channel`) with its
own independent ref-count that `child.unref()` does not touch. Skip it and
a pool child with a persistent message listener (which every pool child
has, so it can be reused for more than one call) keeps the process alive
forever even once fully idle and `unref()`'d — reproduced with a single
forked child, no pool involved. `src/loader.ts`'s `refChild()`/`unrefChild()`
toggle both together.

(A related, narrower gotcha specific to this package's own test suite, not
its public behavior: `node:test`'s `test()` wrapping so much as one
`await`ed call to this library — no assertions, nothing else in the file —
reproducibly hangs 30–70+ seconds, spinning CPU, before the process exits.
The identical call without the `node:test` wrapper exits in well under a
second. `test/harness.mjs` is a ~20-line stand-in that sidesteps it; nothing
here indicates real programs using this package hit the same thing, since
they don't run through `node:test`.)

### Streaming

The obvious design for `transformStream` — Go calls back into JS once per
chunk, blocking on the callback's return value for backpressure — doesn't
work here: a koffi callback invoked from a background thread only
synchronizes up to the point the JS function *itself* returns, which for an
`async` function is its first `await`, not its eventual resolution. Using
that for backpressure would hand the native side a not-yet-resolved value
and carry on regardless — exactly the class of bug the synchronous-only
rule above exists to avoid.

Instead, streaming is **pull-based**: `TransformToStart` runs the transform
on its own goroutine, writing each chunk into a small buffered Go channel
(this is what backpressure actually is here — the channel send blocks when
full, an ordinary goroutine-to-goroutine handoff); `TransformToNext` pulls
one chunk at a time; `TransformToResult` fetches the final diagnostics/
metadata once `Next` reports done; `TransformToFree` cancels (if not
already finished) and releases the handle — always called exactly once,
whether the stream was read to completion or abandoned early, since an
abandoned stream's goroutine would otherwise block forever on an unread
channel send. Nothing in this path ever calls back into JS.

## Building from source

Requires Go ≥ 1.25, a C compiler (cgo, for `native/` only — the underlying
Go library stays cgo-free), and Node ≥ 20.

```sh
npm install
npm run build   # tsup (TS -> dist/{index,child}.{js,cjs,d.ts}) + go build -> dist/native/*
npm test
```

`npm test` runs each `test/*.test.js` file directly with plain `node` (not
`node --test` — see the `node:test` gotcha above), stopping at the first
file that exits non-zero.

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
npm version 0.1.3 --no-git-tag-version
git commit -am "release v0.1.3"
git push

# 2. tag and push — this triggers the release workflow
git tag v0.1.3
git push origin v0.1.3
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
of [go-xslt](https://github.com/tim-riep/go-xslt) (Apache-2.0) — see
[NOTICE](./NOTICE).
