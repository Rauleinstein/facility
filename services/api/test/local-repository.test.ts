import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { localCatalogFiles } from "../src/agents/catalog.js";
import {
  assertLocalRepositorySourceWithinRoot,
  LocalRepositorySourceSchema,
  repositoryCloneSource,
  repositorySourceFromSettings,
} from "../src/workspaces/local-repository.js";
import {
  projectWorkspaceInput,
  repositoryCloneArgs,
} from "../src/workspaces/project-environment.js";

const execFileAsync = promisify(execFile);

describe("local repository source", () => {
  it("accepts an absolute local path and exposes it as the clone source", () => {
    const source = LocalRepositorySourceSchema.parse({
      type: "local",
      path: "/home/developer/projects/app",
      name: "app",
    });
    expect(repositoryCloneSource(source)).toBe("/home/developer/projects/app");
  });

  it("accepts a local git remote and rejects missing or ambiguous sources", () => {
    expect(
      repositoryCloneSource(
        LocalRepositorySourceSchema.parse({
          type: "local",
          remote: "file:///srv/git/app.git",
          name: "app",
        }),
      ),
    ).toBe("/srv/git/app.git");
    expect(() => LocalRepositorySourceSchema.parse({ type: "local", name: "app" })).toThrow(
      /exactly one/i,
    );
    expect(() =>
      LocalRepositorySourceSchema.parse({
        type: "local",
        path: "relative/app",
        remote: "file:///srv/git/app.git",
        name: "app",
      }),
    ).toThrow(/absolute|exactly one/i);
  });

  it("uses local sources without constructing a GitHub clone URL", () => {
    const source = LocalRepositorySourceSchema.parse({
      type: "local",
      path: "/srv/app",
      name: "app",
    });
    expect(
      repositoryCloneArgs(
        { owner: "local", name: "app", defaultBranch: "main", role: "primary", source },
        "https://github.com",
        "repos/local/app",
      ),
    ).toEqual(["clone", "/facility-local-repositories/local/app", "repos/local/app"]);
  });

  it("keeps GitHub clone URL construction unchanged", () => {
    expect(
      repositoryCloneArgs(
        { owner: "acme", name: "app", defaultBranch: "main", role: "primary" },
        "https://github.example",
        "repos/acme/app",
      ),
    ).toEqual(["clone", "https://github.example/acme/app.git", "repos/acme/app"]);
  });

  it("reads agent catalogs from a local bare git remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-local-bare-"));
    const worktree = join(root, "worktree");
    const bare = join(root, "app.git");
    await mkdir(worktree, { recursive: true });
    await execFileAsync("git", ["init", "--bare", bare]);
    await execFileAsync("git", ["init", "-b", "main", worktree]);
    await mkdir(join(worktree, ".agents"));
    await writeFile(join(worktree, ".agents", "builder.md"), "agent");
    await execFileAsync("git", ["-C", worktree, "add", "."]);
    await execFileAsync("git", [
      "-C",
      worktree,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ]);
    await execFileAsync("git", ["-C", worktree, "remote", "add", "origin", bare]);
    await execFileAsync("git", ["-C", worktree, "push", "origin", "main"]);

    const files = await localCatalogFiles({
      type: "local",
      remote: bare,
      name: "app",
      owner: "local",
      defaultBranch: "main",
    });
    expect(files.get(".agents/builder.md")).toBe("agent");
  });

  it("does not follow symlinked catalog files", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-local-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "facility-local-outside-"));
    await mkdir(join(root, ".agents"));
    await writeFile(join(outside, "secret.md"), "secret");
    await (await import("node:fs/promises")).symlink(
      join(outside, "secret.md"),
      join(root, ".agents", "secret.md"),
    );
    const files = await localCatalogFiles({
      type: "local",
      path: root,
      name: "app",
      owner: "local",
      defaultBranch: "main",
    });
    expect(files.has(".agents/secret.md")).toBe(false);
  });

  it("adds a read-only Docker mount for local repositories", () => {
    const input = projectWorkspaceInput(
      {
        version: 1,
        repositories: { primary: "local/app", related: [] },
        environment: { start: "npm start", secrets: [], variables: [], services: {} },
        hash: "hash",
        localRepositorySources: [
          { type: "local", path: "/srv/app", name: "app", owner: "local", defaultBranch: "main" },
        ],
      },
      "facility-runner:dev",
    );
    expect(input.mounts).toEqual([
      {
        type: "bind",
        source: "/srv/app",
        target: "/facility-local-repositories/local/app",
        readOnly: true,
      },
    ]);
  });

  it("rejects local sources outside the configured repository root", () => {
    expect(() =>
      assertLocalRepositorySourceWithinRoot(
        LocalRepositorySourceSchema.parse({
          type: "local",
          path: "/srv/facility-repositories/../etc",
          name: "app",
        }),
        "/srv/facility-repositories",
      ),
    ).toThrow(/under the configured local repository root/i);
    expect(() =>
      assertLocalRepositorySourceWithinRoot(
        LocalRepositorySourceSchema.parse({
          type: "local",
          remote: "file:///srv/facility-repositories/app.git",
          name: "app",
        }),
        "/srv/facility-repositories",
      ),
    ).not.toThrow();
  });

  it("requires an explicit local discriminator in project settings", () => {
    expect(() => repositorySourceFromSettings({})).toThrow(/repositorySource/i);
    expect(() =>
      repositorySourceFromSettings({
        repositorySource: { type: "github", owner: "acme", name: "app" },
      }),
    ).toThrow(/local/i);
    expect(
      repositorySourceFromSettings({
        repositorySource: { type: "local", path: "/srv/app", name: "app" },
      }),
    ).toMatchObject({ type: "local", path: "/srv/app", name: "app" });
  });
});
