import type { WorkspaceRepository } from "./credentials.js";
import type { ProjectManifest } from "./project-environment.js";
import type { WorkspaceCommandResult, WorkspaceLocator } from "./runtime.js";

/** Commands bound to one workspace preparation, for repository sources. */
export type WorkspaceGit = {
  orgId: string;
  projectId: string;
  workspace: WorkspaceLocator;
  manifest: ProjectManifest;
  repositories: WorkspaceRepository[];
  /** Runs a command and throws an environment failure, with redacted output, if it fails. */
  run(
    command: string,
    args: string[],
    cwd: string,
    phase: string,
    stdin?: string,
  ): Promise<WorkspaceCommandResult>;
  /** Runs a command and returns its result whatever the exit code. */
  probe(command: string, args: string[], cwd?: string): Promise<WorkspaceCommandResult>;
};

/** How a repository's history gets into a workspace and where story branches start. */
export interface WorkspaceRepositorySource {
  /** Brings the repository at `cwd` up to date; `present` says a Git directory exists there. */
  materialize(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    present: boolean,
  ): Promise<void>;
  /** `git switch -c <branch>` arguments after the branch name, for a new story branch. */
  storyBranchStart(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    branch: string,
  ): Promise<string[]>;
  /** What a turn records about the source it ran against, once the workspace is prepared. */
  turnEvidence(git: WorkspaceGit): Promise<Record<string, unknown> | null>;
}

/** A GitHub repository: cloned once, fetched before every turn, branches tracked from origin. */
export class GithubWorkspaceSource implements WorkspaceRepositorySource {
  constructor(private readonly gitBaseUrl: string) {}

  async materialize(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    present: boolean,
  ) {
    if (!present) {
      await git.run(
        "git",
        ["clone", `${this.gitBaseUrl}/${repository.owner}/${repository.name}.git`, cwd],
        ".",
        `clone ${repository.owner}/${repository.name}`,
      );
    }
    await git.run("git", ["fetch", "--all", "--prune"], cwd, "git fetch");
  }

  async storyBranchStart(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    branch: string,
  ) {
    const remote = await git.probe(
      "git",
      ["show-ref", "--verify", `refs/remotes/origin/${branch}`],
      cwd,
    );
    return remote.exitCode === 0
      ? ["--track", `origin/${branch}`]
      : [`origin/${repository.defaultBranch}`];
  }

  /** A GitHub turn's source is its pushed branch; there is nothing extra to record. */
  async turnEvidence() {
    return null;
  }
}
