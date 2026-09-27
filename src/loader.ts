import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Go-provided class from wasm_exec.cjs (vendored from the Go toolchain's
// lib/wasm/wasm_exec.js at build time — see scripts/build-wasm.sh).
interface GoInstance {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface GoConstructor {
  new (): GoInstance;
}

// The functions go/main.go registers on globalThis.__goXslt.
// transform/validate/evalXPath each take a JSON request string and resolve
// to a JSON response string; they never reject (engine errors come back as
// {diagnostics: [...]} JSON, not as thrown/rejected values — see
// go/main.go's asyncJSONFunc). transformTo instead streams its output: it
// calls onChunk once per internal write with a Uint8Array copy (safe to
// retain), then resolves to a JSON response string with output left empty,
// same as the others. onChunk may return void or a Promise; when it returns
// a Promise, the Go side blocks the transform on it, so a slow consumer
// (e.g. a Readable a caller is piping to a slow destination) applies real
// backpressure all the way back into the engine.
interface GoXsltBridge {
  transform(reqJSON: string): Promise<string>;
  validate(reqJSON: string): Promise<string>;
  evalXPath(reqJSON: string): Promise<string>;
  transformTo(
    reqJSON: string,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var Go: GoConstructor | undefined;
  // eslint-disable-next-line no-var
  var __goXslt: GoXsltBridge | undefined;
  // eslint-disable-next-line no-var
  var __goXsltInit: (() => void) | undefined;
}

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.join(here, "wasm");

let bridgePromise: Promise<GoXsltBridge> | undefined;

function installFsShim(): void {
  // wasm_exec.js's syscall/js filesystem shim needs a Node-callback-shaped
  // `fs` global to exist *before* it is loaded, or it falls back to a stub
  // that rejects every operation with ENOSYS. Node's own `fs` module already
  // implements that exact callback shape (open/read/write/close/stat/...),
  // so this single assignment is what gives document(), xsl:include,
  // xsl:result-document and collections real disk access from inside wasm.
  const g = globalThis as unknown as { fs?: unknown };
  if (!g.fs) {
    g.fs = nodeFs;
  }
}

async function loadBridge(): Promise<GoXsltBridge> {
  installFsShim();

  if (typeof globalThis.Go !== "function") {
    // wasm_exec.cjs is a plain script (no import/export) that sets
    // globalThis.Go as a side effect; .cjs guarantees Node's ESM loader
    // runs it through the CommonJS path regardless of this package's own
    // module type.
    require(path.join(wasmDir, "wasm_exec.cjs"));
  }

  const ready = new Promise<void>((resolve) => {
    globalThis.__goXsltInit = resolve;
  });

  const go = new globalThis.Go!();
  const wasmBuffer = await readFile(path.join(wasmDir, "go-xslt.wasm"));
  const { instance } = await WebAssembly.instantiate(
    wasmBuffer,
    go.importObject,
  );

  // Deliberately not awaited: go.run()'s promise only resolves when the Go
  // program *exits*, and go/main.go's program never does (it parks in
  // select{} forever so the callbacks below stay callable). Any unexpected
  // exit (a Go runtime-level failure, not an engine error — those are
  // reported as diagnostics, never a crash) surfaces here instead of as an
  // unhandled rejection.
  go.run(instance).catch((err: unknown) => {
    console.error("node-xslt: wasm runtime exited unexpectedly", err);
  });

  await ready;
  globalThis.__goXsltInit = undefined;

  return globalThis.__goXslt!;
}

/**
 * Loads and instantiates the wasm engine on first call; subsequent calls
 * reuse the same instance. Call this ahead of time to pay startup cost
 * (reading + compiling a multi-megabyte wasm module) before the first real
 * request, or just let it happen lazily on first use.
 */
export function getBridge(): Promise<GoXsltBridge> {
  if (!bridgePromise) {
    bridgePromise = loadBridge();
  }
  return bridgePromise;
}
