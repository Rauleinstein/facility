import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseAgentManifest } from "@facility/agents";
import { createDb } from "@facility/db";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { createStoryDomain } from "../src/story-domain.js";
import { AgentEngineError, CodexEngine, ScriptedEngine } from "../src/turns/engines.js";
import type {
  WorkspaceCommand,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../src/workspaces/runtime.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workspace: WorkspaceLocator = {
  id: "ws_0123456789abcdef",
  image: "facility-runner:test",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "volume",
};
const manifest = parseAgentManifest(
  `---
name: builder
description: Test agent.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Test prompt.
`,
  "builder.md",
);

/** Runs workspace commands on the host, so the engine's script meets real Git. */
function hostRuntime(commands: WorkspaceCommand[] = []) {
  return {
    async exec(_workspace: WorkspaceLocator, command: WorkspaceCommand) {
      commands.push(command);
      const startedAt = Date.now();
      try {
        const { stdout, stderr } = await run(command.command, command.args ?? [], {
          cwd: command.cwd,
          env: { ...process.env, ...command.env },
        });
        return { exitCode: 0, stdout, stderr, durationMs: Date.now() - startedAt };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: failure.code ?? 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          durationMs: Date.now() - startedAt,
        };
      }
    },
  } as unknown as WorkspaceRuntime;
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "facility-scripted-"));
  roots.push(root);
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], {
      cwd: root,
    });
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "chore: initial");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@localhost");
  return root;
}

describe("scripted engine", () => {
  it("commits one deterministic change per turn without calling a model", async () => {
    const cwd = await repository();
    const commands: WorkspaceCommand[] = [];
    const engine = new ScriptedEngine("codex", hostRuntime(commands));
    for (const turnId of ["turn_first", "turn_second"]) {
      const result = await engine.run({ turnId, manifest, workspace, prompt: "anything", cwd });
      expect(result).toMatchObject({ exitCode: 0, nativeSessionId: `scripted-${turnId}` });
    }
    expect(await readFile(join(cwd, "facility-e2e.txt"), "utf8")).toBe("turn_first\nturn_second\n");
    const { stdout } = await run("git", ["log", "--format=%s"], { cwd });
    expect(stdout.trim().split("\n")).toEqual([
      "feat: scripted change",
      "feat: scripted change",
      "chore: initial",
    ]);
    // The prompt never reaches the shell.
    expect(commands.every((command) => !JSON.stringify(command).includes("anything"))).toBe(true);
  });

  it("fails the turn when its command fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "facility-scripted-nogit-"));
    roots.push(cwd);
    const engine = new ScriptedEngine("claude_code", hostRuntime());
    await expect(
      engine.run({ turnId: "turn_x", manifest, workspace, prompt: "p", cwd }),
    ).rejects.toBeInstanceOf(AgentEngineError);
  });
});

describe("FACILITY_TEST_ENGINE", () => {
  const env = {
    DATABASE_URL: "postgres://facility:facility@localhost:5461/facility_test",
    SECRET_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    PUBLIC_URL: "http://localhost:4400",
  };

  it("is off unless requested, and accepts only the scripted engine", () => {
    expect(readConfig(env).testEngine).toBeUndefined();
    expect(readConfig({ ...env, FACILITY_TEST_ENGINE: "scripted" }).testEngine).toBe("scripted");
    expect(() => readConfig({ ...env, FACILITY_TEST_ENGINE: "real" })).toThrow();
  });

  it("is refused in production (regression)", () => {
    expect(() =>
      readConfig({ ...env, NODE_ENV: "production", FACILITY_TEST_ENGINE: "scripted" }),
    ).toThrow("FACILITY_TEST_ENGINE is refused in production");
  });

  it("replaces both engines in the story domain only when requested", async () => {
    const { db, client } = createDb(env.DATABASE_URL);
    try {
      const domain = (config: ReturnType<typeof readConfig>) =>
        createStoryDomain({ db, config, enqueue: async () => null });
      const scripted = domain(readConfig({ ...env, FACILITY_TEST_ENGINE: "scripted" })).engines;
      expect(scripted.get("codex")).toBeInstanceOf(ScriptedEngine);
      expect(scripted.get("claude_code")).toBeInstanceOf(ScriptedEngine);
      expect(domain(readConfig(env)).engines.get("codex")).toBeInstanceOf(CodexEngine);
    } finally {
      await client.end();
    }
  });
});
