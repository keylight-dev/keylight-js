import { defineConfig } from "tsup";
export default defineConfig([
  { entry: ["src/index.ts"], format: ["esm", "cjs"], dts: true, clean: true, sourcemap: true },
  { entry: { keylight: "src/index.ts" }, format: ["iife"], globalName: "Keylight", outDir: "dist", minify: true },
]);
