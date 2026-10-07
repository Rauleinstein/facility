import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Opt-in: `pnpm test:e2e-browser`. Starts its own stack on the `pnpm dev` ports,
// so stop a running `pnpm dev` first. Agents are scripted; no model credentials.
process.env.FACILITY_E2E_REPOSITORY_ROOT ??= join(tmpdir(), "facility-e2e-repositories");

export default defineConfig({
  testDir: "e2e",
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3400",
    actionTimeout: 30_000,
    // The recording is the evidence that the workflow ran.
    video: "on",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ../../scripts/e2e-browser-server.mjs",
    url: "http://localhost:3400/login",
    timeout: 5 * 60_000,
    reuseExistingServer: false,
    // SIGKILL (the default) would orphan turbo's children on the dev ports.
    gracefulShutdown: { signal: "SIGINT", timeout: 20_000 },
    // The stack's logs are long; set FACILITY_E2E_LOGS=1 to see them.
    stdout: process.env.FACILITY_E2E_LOGS === "1" ? "pipe" : "ignore",
  },
});
