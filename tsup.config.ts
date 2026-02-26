import { defineConfig } from "tsup";

export default defineConfig({
  entry:    { index: "src/index.ts" },
  format:   ["esm", "cjs"],
  dts:      true,
  clean:    true,
  // platform: "neutral" — @strand/core has no browser or Node.js specific APIs
  // in its public interface. SharedArrayBuffer and Atomics are identical in
  // both environments. No bundler exclusions needed by consumers.
  platform: "neutral",
});
