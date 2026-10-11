import { Readable } from "node:stream";
import {
  callSimple,
  closePool,
  openStream,
  ready as poolReady,
} from "./loader.js";
import type {
  Diagnostic,
  SecondaryOutput,
  TransformRequest,
  TransformResult,
  TransformStreamMeta,
  ValidateRequest,
  ValidateResult,
  XPathItem,
  XPathRequest,
  XPathResult,
} from "./types.js";

export type {
  Diagnostic,
  Phase,
  SecondaryOutput,
  Severity,
  TransformRequest,
  TransformResult,
  TransformStreamMeta,
  ValidateRequest,
  ValidateResult,
  XPathItem,
  XPathRequest,
  XPathResult,
  XSDVersion,
} from "./types.js";
export { hasErrors } from "./types.js";

// The Go engine marshals a nil slice as JSON `null` rather than `[]`
// (encoding/json's default for zero-value slices); normalize every such
// field back to an array so callers never have to special-case null.
function orEmpty<T>(v: T[] | null | undefined): T[] {
  return v ?? [];
}

function normalizeTransformResult(res: TransformResult): TransformResult {
  return {
    ...res,
    diagnostics: orEmpty<Diagnostic>(res.diagnostics),
    messages: orEmpty<string>(res.messages),
    secondaryOutputs: orEmpty<SecondaryOutput>(res.secondaryOutputs),
  };
}

function normalizeValidateResult(res: ValidateResult): ValidateResult {
  return { ...res, diagnostics: orEmpty<Diagnostic>(res.diagnostics) };
}

function normalizeXPathResult(res: XPathResult): XPathResult {
  return {
    ...res,
    diagnostics: orEmpty<Diagnostic>(res.diagnostics),
    items: orEmpty<XPathItem>(res.items),
  };
}

function normalizeStreamMeta(meta: TransformStreamMeta): TransformStreamMeta {
  return {
    ...meta,
    diagnostics: orEmpty<Diagnostic>(meta.diagnostics),
    messages: orEmpty<string>(meta.messages),
    secondaryOutputs: orEmpty<SecondaryOutput>(meta.secondaryOutputs),
  };
}

/**
 * Runs an XSLT 3.0 transformation and returns the result. Never throws:
 * compile/runtime errors come back as error-severity diagnostics on the
 * result (see {@link hasErrors}).
 */
export async function transform(
  req: TransformRequest,
): Promise<TransformResult> {
  const resJSON = await callSimple("transform", JSON.stringify(req));
  return normalizeTransformResult(JSON.parse(resJSON) as TransformResult);
}

/** What {@link transformStream} returns. */
export interface TransformStreamHandle {
  /** The transformation's output, as a binary (Buffer-chunked) Readable. */
  output: Readable;
  /**
   * Resolves once the transform finishes, with everything a
   * {@link TransformResult} carries except `output` (which the stream above
   * delivers instead). Never rejects for engine-level problems — a
   * compile/run error still comes back as a diagnostic here, with `output`
   * ending (possibly having already emitted partial data — see the note
   * below). `output` being destroyed by its consumer before the transform
   * finishes also comes back as a diagnostic here, not a rejection; this
   * only rejects if the native worker pool itself fails to start.
   */
  result: Promise<TransformStreamMeta>;
}

/**
 * Like {@link transform}, but delivers the serialized result as a stream of
 * chunks instead of buffering it into one string — for results large enough
 * that holding the whole thing in memory matters. `output` applies real
 * backpressure: if its consumer (e.g. a slow disk `output.pipe()`s to) falls
 * behind, the underlying engine itself pauses serializing until the consumer
 * catches up (each next chunk is only pulled from the native side once
 * `output` has room for it).
 *
 * As with the underlying engine's TransformTo, a run-phase error can occur
 * after some output has already been produced (e.g. a runtime error deep
 * into a large document); the diagnostic still arrives on `result`; bytes
 * already emitted on `output` before that point are the caller's to
 * discard.
 */
export function transformStream(req: TransformRequest): TransformStreamHandle {
  let pendingDrain: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;

  const output = new Readable({
    read() {
      if (pendingDrain) {
        const { resolve } = pendingDrain;
        pendingDrain = null;
        resolve();
      }
    },
  });

  output.once("close", () => {
    if (pendingDrain) {
      const { reject } = pendingDrain;
      pendingDrain = null;
      reject(new Error("output stream closed before the transform finished"));
    }
  });

  const result = (async (): Promise<TransformStreamMeta> => {
    let session: Awaited<ReturnType<typeof openStream>> | undefined;
    try {
      session = await openStream(JSON.stringify(req));
      for (;;) {
        const chunk = await session.next();
        if (chunk === null) break;
        if (output.destroyed) {
          throw new Error(
            "output stream closed before the transform finished",
          );
        }
        if (!output.push(chunk)) {
          await new Promise<void>((resolve, reject) => {
            pendingDrain = { resolve, reject };
          });
        }
      }
      const resJSON = await session.result();
      const { output: _output, ...meta } = JSON.parse(
        resJSON,
      ) as TransformResult;
      if (!output.destroyed) output.push(null);
      return normalizeStreamMeta(meta);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (output.destroyed) {
        // The consumer destroying `output` is what caused this (the inline
        // check above, or the "close" listener rejecting a pending drain
        // wait) — an expected abort, not a real failure. Same contract as
        // the underlying engine's TransformTo when a write fails mid-run:
        // report it as a diagnostic, not a rejection; bytes already
        // emitted on `output` are the caller's to discard either way.
        return normalizeStreamMeta({
          diagnostics: [
            {
              severity: "error",
              line: 0,
              col: 0,
              code: "",
              message: error.message,
              phase: "run",
            },
          ],
          durationMs: 0,
          method: "",
          messages: [],
          secondaryOutputs: [],
        });
      }
      output.destroy(error);
      throw error;
    } finally {
      await session?.free();
    }
  })();

  return { output, result };
}

/**
 * Validates an XML instance document against one or more XSD 1.0/1.1
 * schemas. Never throws: schema-compile and validation errors come back as
 * diagnostics with valid: false.
 */
export async function validate(
  req: ValidateRequest,
): Promise<ValidateResult> {
  const resJSON = await callSimple("validate", JSON.stringify(req));
  return normalizeValidateResult(JSON.parse(resJSON) as ValidateResult);
}

/**
 * Evaluates a standalone XPath 3.1 expression, optionally against an XML
 * context document. Never throws: parse/eval errors come back as
 * diagnostics.
 */
export async function evalXPath(req: XPathRequest): Promise<XPathResult> {
  const resJSON = await callSimple("evalXPath", JSON.stringify(req));
  return normalizeXPathResult(JSON.parse(resJSON) as XPathResult);
}

/**
 * Pre-loads the native worker pool so the first real call doesn't pay that
 * startup cost. Optional — every exported function above lazily loads it on
 * first use anyway.
 */
export async function ready(): Promise<void> {
  await poolReady();
}

/**
 * Terminates the pool's child processes and forgets them; the next call
 * starts a fresh pool. Not needed for normal use — pool children never keep
 * a process alive on their own, so a script or server can just exit
 * normally — but useful when something wants deterministic, immediate
 * shutdown instead (a short-lived CLI, a test suite).
 */
export async function close(): Promise<void> {
  await closePool();
}
