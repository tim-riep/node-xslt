// A minimal stand-in for node:test's test()/assert pairing.
//
// Why not node:test: it does not get along with this package's
// child_process-based worker pool. A file with nothing but
// `import { test } from "node:test"` wrapping a single `await transform(...)`
// call — no assertions, no other code — hangs for 30-70+ seconds (spinning
// CPU, not idle) after the call completes instead of exiting; the identical
// call without the node:test wrapper finishes and exits in well under a
// second. Reproduced in isolation, so it isn't specific to any one test
// here. node:test appears to track child processes in a way this package's
// pool (deliberately long-lived, unref()d, real OS processes rather than
// worker_threads — see src/loader.ts's top comment for why) doesn't satisfy.
let passed = 0;
let failed = 0;

export async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✔ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✖ ${name}`);
    console.error(err);
  }
}

export function summary() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}
