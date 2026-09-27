import { Readable } from "node:stream";
import { getBridge } from "./loader.js";
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
  const bridge = await getBridge();
  const resJSON = await bridge.transform(JSON.stringify(req));
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
   * below); it can reject if the engine itself fails to load, or if `output`
   * is destroyed by its consumer before the transform finishes.
   */
  result: Promise<TransformStreamMeta>;
}

/**
 * Like {@link transform}, but delivers the serialized result as a stream of
 * chunks instead of buffering it into one string — for results large enough
 * that holding the whole thing in memory (on either side of the WASM
 * boundary) matters. `output` applies real backpressure: if its consumer
 * (e.g. a slow disk `output.pipe()`s to) falls behind, the underlying engine
 * itself pauses serializing until the consumer catches up.
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

  function onChunk(chunk: Uint8Array): void | Promise<void> {
    if (output.destroyed) {
      return Promise.reject(
        new Error("output stream closed before the transform finished"),
      );
    }
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (output.push(buf)) return;
    return new Promise<void>((resolve, reject) => {
      pendingDrain = { resolve, reject };
    });
  }

  const result = (async (): Promise<TransformStreamMeta> => {
    try {
      const bridge = await getBridge();
      const resJSON = await bridge.transformTo(JSON.stringify(req), onChunk);
      const { output: _output, ...meta } = JSON.parse(
        resJSON,
      ) as TransformResult;
      if (!output.destroyed) output.push(null);
      return normalizeStreamMeta(meta);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!output.destroyed) output.destroy(error);
      throw error;
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
  const bridge = await getBridge();
  const resJSON = await bridge.validate(JSON.stringify(req));
  return normalizeValidateResult(JSON.parse(resJSON) as ValidateResult);
}

/**
 * Evaluates a standalone XPath 3.1 expression, optionally against an XML
 * context document. Never throws: parse/eval errors come back as
 * diagnostics.
 */
export async function evalXPath(req: XPathRequest): Promise<XPathResult> {
  const bridge = await getBridge();
  const resJSON = await bridge.evalXPath(JSON.stringify(req));
  return normalizeXPathResult(JSON.parse(resJSON) as XPathResult);
}

/**
 * Pre-loads and instantiates the wasm engine so the first real call doesn't
 * pay that startup cost. Optional — every exported function lazily loads the
 * engine on first use anyway.
 */
export async function ready(): Promise<void> {
  await getBridge();
}
