import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Why child_process instead of worker_threads: koffi's own `.func.async()`
// leaves its internal worker-pool threads spinning at ~100% CPU per thread
// indefinitely after the call completes — reproduced directly against this
// library, a single async call is enough and the process never exits on its
// own. Plain synchronous calls don't have that problem *on the main
// thread*, but loading this same native library inside a worker_thread —
// even calling it purely synchronously, even after unref()ing the worker —
// leaves the process unable to exit on its own too; reproduced with nothing
// but koffi.load() + one sync call in a worker_thread and no code of ours
// involved. The identical script run as a real child_process (this file)
// exits cleanly in well under a second. So: every call runs synchronously
// inside a child_process, never on the main thread and never via
// worker_threads or koffi's async calls.
const here = path.dirname(fileURLToPath(import.meta.url));

// One package carries the native library for every supported platform under
// dist/native/ (built per platform in CI, see .github/workflows/_build.yml);
// pick the one matching this machine.
function nativeLibPath(): string {
  const key = `${process.platform}-${process.arch}`;
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  const file = path.join(here, "native", `goxslt-${key}.${ext}`);
  if (!existsSync(file)) {
    throw new Error(
      `@tim-riep/node-xslt has no native library for ${key} (looked for ${file}). ` +
        `Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64, ` +
        `win32-arm64, win32-x64 (Linux: glibc only, not musl/Alpine). In a ` +
        `development checkout, run \`npm run build\` first.`,
    );
  }
  return file;
}

interface ChildResponse {
  id: number;
  result?: unknown;
  error?: string;
  ready?: true;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One child process, each with its own loaded instance of the native
 * library. Calls into it are dispatched with a request id and resolved when
 * the matching response arrives — see src/child.ts for the other end.
 *
 * `busy` pins a child to a single in-flight streaming session (Start
 * through Free must all land on the same child, since a stream handle only
 * means something to the native-library instance that created it); plain
 * transform/validate/evalXPath calls ignore it and use any child.
 */
class PoolChild {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  busy = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(libPath: string) {
    // Strip NODE_CHANNEL_FD: when this code itself runs inside a process
    // Node already fork()ed (e.g. a `node --test` test-file child, which
    // gets its own IPC channel back to the test runner that way), that
    // variable is in process.env pointing at THAT channel's fd. Spreading
    // process.env wholesale into a *new* fork's env leaks it into the
    // child, which then gets confused about which fd its own IPC channel
    // actually is — observed as the child and parent both going silent
    // forever mid-call, never an error, just a dead channel.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_XSLT_LIB_PATH: libPath,
    };
    delete env.NODE_CHANNEL_FD;
    this.child = fork(path.join(here, "child.js"), {
      env,
      serialization: "advanced", // efficient Buffer transfer, not base64-in-JSON
    });
    this.ready = new Promise((resolve, reject) => {
      const onExit = (code: number | null) => {
        reject(new Error(`node-xslt child process exited early (code ${code})`));
      };
      this.child.once("exit", onExit);
      this.child.once("error", reject);
      this.child.once("message", (msg: ChildResponse) => {
        this.child.off("exit", onExit);
        if (msg.ready) {
          // Nothing queued yet (call() always awaits the pool's readiness
          // before dispatching) — safe to drop out of the process's
          // keep-alive set immediately.
          this.unrefChild();
          resolve();
        } else {
          reject(
            new Error("node-xslt child process sent an unexpected first message"),
          );
        }
      });
    });
    this.child.on("message", (msg: ChildResponse) => {
      if (msg.ready) return;
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      // Only ref the child while a call is actually outstanding (see call()
      // below); once the last one settles, let the process exit naturally
      // if nothing else is keeping it alive instead of holding it open
      // forever for a pool child that may never be used again.
      if (this.pending.size === 0) this.unrefChild();
      if (msg.error !== undefined) call.reject(new Error(msg.error));
      else call.resolve(msg.result);
    });
    this.child.on("error", (err) => {
      for (const call of this.pending.values()) call.reject(err);
      this.pending.clear();
      this.unrefChild();
    });
    this.child.on("exit", (code) => {
      if (this.pending.size === 0) return;
      const err = new Error(`node-xslt child process exited (code ${code})`);
      for (const call of this.pending.values()) call.reject(err);
      this.pending.clear();
    });
  }

  // child.unref()/.ref() alone is not enough: the IPC channel underlying
  // send()/on('message') holds its own, independent keep-alive handle
  // (child.channel), which child.unref() does not touch. Skipping this
  // leaves the channel ref'd forever, and the process never exits on its
  // own even once every child in the pool is otherwise idle — reproduced
  // with a single forked child, no pool involved.
  private refChild(): void {
    this.child.ref();
    this.child.channel?.ref();
  }

  private unrefChild(): void {
    this.child.unref();
    this.child.channel?.unref();
  }

  call(kind: string, payload?: unknown): Promise<unknown> {
    const id = this.nextId++;
    if (this.pending.size === 0) this.refChild();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, kind, payload });
    });
  }
}

// A small fixed pool: enough for real concurrency without spawning a child
// process (each with its own copy of the native library mapped into memory)
// per call. Streaming pins one child for its duration, so a pool of 1 would
// serialize a stream behind every other concurrent call; this default
// leaves room for that without scaling unbounded on very large machines.
const POOL_SIZE = Math.max(2, Math.min(4, os.cpus().length));

let poolPromise: Promise<PoolChild[]> | undefined;

function getPool(): Promise<PoolChild[]> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const libPath = nativeLibPath();
      const children = Array.from(
        { length: POOL_SIZE },
        () => new PoolChild(libPath),
      );
      await Promise.all(children.map((c) => c.ready));
      return children;
    })();
  }
  return poolPromise;
}

/**
 * Terminates every child process in the pool and forgets it, so the next
 * call starts a fresh one. Not needed for normal use — pool children are
 * unref()d and never keep a process alive on their own — but useful for
 * anything that wants deterministic, immediate shutdown rather than relying
 * on process exit to eventually reclaim them (this package's own test
 * suite; a short-lived CLI that wants to exit the instant it's done).
 */
export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const children = await poolPromise;
  poolPromise = undefined;
  for (const c of children) c.child.kill();
}

let rrIndex = 0;

async function pickChild(): Promise<PoolChild> {
  const children = await getPool();
  for (let i = 0; i < children.length; i++) {
    const c = children[(rrIndex + i) % children.length];
    if (!c.busy) {
      rrIndex = (rrIndex + i + 1) % children.length;
      return c;
    }
  }
  // Every child is mid-stream. Each TransformToNext call is individually
  // short (one buffer's worth of work), so sharing one anyway just
  // interleaves fairly rather than blocking outright.
  const c = children[rrIndex % children.length];
  rrIndex = (rrIndex + 1) % children.length;
  return c;
}

/**
 * Pre-loads the child process pool so the first real call doesn't pay that
 * startup cost. Optional — every call below does it lazily on first use
 * anyway.
 */
export async function ready(): Promise<void> {
  await getPool();
}

export async function callSimple(
  kind: "transform" | "validate" | "evalXPath",
  reqJSON: string,
): Promise<string> {
  const c = await pickChild();
  return (await c.call(kind, reqJSON)) as string;
}

/** A single open streaming transform, pinned to one child process. */
export interface StreamSession {
  /** Pulls the next chunk, or null once the transform is done. */
  next(): Promise<Buffer | null>;
  /** Call once, after next() has returned null, to get the final result. */
  result(): Promise<string>;
  /**
   * Always call exactly once, whether the stream was read to completion or
   * abandoned early — releases the child back to the pool and the native
   * handle. Cancels the underlying transform if it hadn't finished.
   */
  free(): Promise<void>;
}

export async function openStream(reqJSON: string): Promise<StreamSession> {
  const c = await pickChild();
  c.busy = true;
  const handle = (await c.call("transformToStart", reqJSON)) as number;
  let freed = false;
  return {
    async next() {
      const chunk = await c.call("transformToNext", handle);
      if (chunk === null) return null;
      // 'advanced' IPC serialization round-trips a Buffer as a Uint8Array,
      // not necessarily a Buffer instance — normalize without copying.
      return Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(
            (chunk as Uint8Array).buffer,
            (chunk as Uint8Array).byteOffset,
            (chunk as Uint8Array).byteLength,
          );
    },
    async result() {
      return (await c.call("transformToResult", handle)) as string;
    },
    async free() {
      if (freed) return;
      freed = true;
      try {
        await c.call("transformToFree", handle);
      } finally {
        c.busy = false;
      }
    },
  };
}
