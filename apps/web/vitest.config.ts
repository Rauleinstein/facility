import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The app's tsconfig sets jsx: "preserve" for Next's own compiler, which the
// test transform can't consume — components under test are .tsx, so the runner
// needs its own JSX runtime. The alias mirrors Next's "@/…" tsconfig path.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },
  // e2e/ is Playwright's (`pnpm test:e2e-browser`), not vitest's.
  test: { exclude: ["e2e/**", "node_modules/**"] },
});
