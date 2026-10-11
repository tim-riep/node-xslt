// Runs as a real child process (see loader.ts, which spawns this via
// node:child_process's fork()), not a worker_thread. Owns one loaded
// instance of the native library and makes only SYNCHRONOUS koffi calls into
// it — see loader.ts's top comment for why koffi's own `.func.async()` is
// unusable here, and why worker_threads specifically (not just async calls)
// turned out not to work either: loading this same native library inside a
// worker_thread — even calling it purely synchronously, even after
// unref()ing everything — left the process unable to exit on its own,
// reproduced with nothing but koffi.load() + one sync call in a worker and
// no code of ours involved. The identical script run as a child_process
// exits cleanly in well under a second. A real OS process is also, if
// anything, a *stronger* isolation boundary than a worker_thread for what
// this module is for: giving each concurrent transform a real OS-level
// unit that can run in parallel and whose memory is fully reclaimed by the
// OS the moment it exits.
import koffi from "koffi";

const lib = koffi.load((process.env.NODE_XSLT_LIB_PATH as string));

const Free = lib.func("void Free(void *ptr)");
// A disposable type makes koffi call Free(ptr) itself right after copying
// the C string into a JS string — using OUR OWN exported Free (which calls
// this library's C.free, i.e. whatever allocator its own C.CString used),
// not koffi's default koffi.free(). Those are not guaranteed to be the same
// allocator, especially on Windows where a shared library can be linked
// against a different CRT than the one koffi's native module uses.
const FreeableString = koffi.disposable("FreeableString", "str", Free);

const Transform = lib.func("Transform", FreeableString, ["str"]);
const Validate = lib.func("Validate", FreeableString, ["str"]);
const EvalXPath = lib.func("EvalXPath", FreeableString, ["str"]);
const TransformToStart = lib.func("TransformToStart", "uintptr_t", ["str"]);
const TransformToNext = lib.func("TransformToNext", "uint8_t *", [
  "uintptr_t",
  "_Out_ int *",
]);
const TransformToResult = lib.func("TransformToResult", FreeableString, [
  "uintptr_t",
]);
const TransformToFree = lib.func("TransformToFree", "void", ["uintptr_t"]);

interface Request {
  id: number;
  kind:
    | "transform"
    | "validate"
    | "evalXPath"
    | "transformToStart"
    | "transformToNext"
    | "transformToResult"
    | "transformToFree";
  payload?: unknown;
}

function handle(req: Request): unknown {
  switch (req.kind) {
    case "transform":
      return Transform(req.payload as string);
    case "validate":
      return Validate(req.payload as string);
    case "evalXPath":
      return EvalXPath(req.payload as string);
    case "transformToStart":
      return TransformToStart(req.payload as string);
    case "transformToNext": {
      const lenBox = [0];
      const ptr = TransformToNext(req.payload as number, lenBox);
      if (ptr === null) return null;
      const len = lenBox[0];
      const copy = Buffer.from(new Uint8Array(koffi.view(ptr, len)));
      Free(ptr);
      return copy;
    }
    case "transformToResult":
      return TransformToResult(req.payload as number);
    case "transformToFree":
      TransformToFree(req.payload as number);
      return null;
  }
}

process.on("message", (req: Request) => {
  try {
    process.send!({ id: req.id, result: handle(req) });
  } catch (err) {
    process.send!({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

process.send!({ id: 0, ready: true });
