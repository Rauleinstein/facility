#!/usr/bin/env node
// Starts Facility for the browser end-to-end test (apps/web/e2e): its own
// `facility_e2e` database, the scripted agent engine instead of real models,
// and local repositories only from the test's temporary root.
//
// The API, worker and UI are this process's direct children, without turbo, so
// Playwright's process-group shutdown stops all of them and they inherit this
// environment unfiltered. Everything not set here comes from .env.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareDevEnv, run } from "./dev.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const root = process.env.FACILITY_E2E_REPOSITORY_ROOT;
if (!root) throw new Error("FACILITY_E2E_REPOSITORY_ROOT is required");
mkdirSync(root, { recursive: true });

await prepareDevEnv(repoRoot);
const compose = ["compose", "-f", "docker-compose.dev.yml"];
await run("docker", [...compose, "up", "-d", "--wait", "postgres"], { cwd: repoRoot });
const psql = (sql) =>
  execFileSync(
    "docker",
    [...compose, "exec", "-T", "postgres", "psql", "-U", "facility", "-Atc", sql],
    { cwd: repoRoot, encoding: "utf8" },
  );
if (!psql("select 1 from pg_database where datname = 'facility_e2e'").trim()) {
  psql("create database facility_e2e");
}

const environment = {
  ...process.env,
  DATABASE_URL: "postgres://facility:facility@localhost:5461/facility_e2e",
  FACILITY_TEST_ENGINE: "scripted",
  FACILITY_LOCAL_REPOSITORY_ROOTS: root,
};
await run(pnpm, ["exec", "turbo", "run", "build", "--filter=@facility/api^...", "--filter=@facility/web^..."], {
  cwd: repoRoot,
});
await run(pnpm, ["--filter", "@facility/db", "migrate"], { cwd: repoRoot, environment });
await run(pnpm, ["--filter", "@facility/db", "seed"], {
  cwd: repoRoot,
  environment: { ...environment, FACILITY_SEED_DEMO: "1" },
});

const children = [
  ["@facility/api", "exec", "tsx", "src/dev.ts"],
  ["@facility/api", "exec", "tsx", "src/worker.ts"],
  ["@facility/web", "run", "dev"],
].map(([filter, ...args]) =>
  spawn(pnpm, ["--filter", filter, ...args], { cwd: repoRoot, env: environment, stdio: "inherit" }),
);
for (const child of children) {
  child.once("exit", (code) => {
    for (const other of children) other.kill("SIGTERM");
    process.exitCode = code ?? 1;
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
