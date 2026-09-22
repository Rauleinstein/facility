import { describe, expect, it } from "vitest";
import {
  LocalRepositorySourceSchema,
  repositoryCloneSource,
  repositorySourceFromSettings,
} from "../src/workspaces/local-repository.js";
import {
  projectWorkspaceInput,
  repositoryCloneArgs,
} from "../src/workspaces/project-environment.js";

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
