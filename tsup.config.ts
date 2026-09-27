import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  platform: "node",
  // index.ts uses import.meta.url (to locate dist/wasm/* next to the built
  // file) and createRequire; tsup only shims these for the CJS output when
  // asked to.
  shims: true,
});
