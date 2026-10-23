import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/child.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  // loader.ts uses import.meta.url (to locate dist/native/* and dist/child.js
  // next to the built file); tsup only shims that for the CJS output when
  // asked to.
  shims: true,
  // koffi does its own platform/arch detection to load its native addon;
  // bundling it would break that.
  external: ["koffi"],
});
