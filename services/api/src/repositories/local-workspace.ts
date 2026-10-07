import { randomUUID } from "node:crypto";
import { type FacilityDb, workspaces } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import type { WorkspaceRepository } from "../workspaces/credentials.js";
import { appendWorkspaceEvent } from "../workspaces/events.js";
import { ProjectEnvironmentError, repositoryPath } from "../workspaces/project-environment.js";
import type { WorkspaceGit, WorkspaceRepositorySource } from "../workspaces/repository-sources.js";
import type { WorkspaceRuntime } from "../workspaces/runtime.js";

/** Packages committed local history for import into a workspace. */
export interface LocalSnapshotProvider {
  snapshot(
    orgId: string,
    projectId: string,
    repositoryId: string,
    commit?: string,
  ): Promise<{ commit: string; branch: string; bundle: Buffer; warnings: string[] }>;
}

/**
 * A local repository in a workspace. History arrives as a Git bundle of one
 * pinned host commit; the host repository is only read. Later turns keep the
 * workspace's history, and refreshing from the host is an explicit operation
 * that never moves a story branch.
 */
export class LocalWorkspaceSource implements WorkspaceRepositorySource {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly snapshots: LocalSnapshotProvider,
  ) {}

  async materialize(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    present: boolean,
  ) {
    // The source ref, not the directory, marks a completed import: an interrupted
    // import leaves an empty repository that must be imported again.
    const imported =
      present &&
      (
        await git.probe("git", [
          "-C",
          cwd,
          "rev-parse",
          "--verify",
          "--quiet",
          `${localSourceRef(repository)}^{commit}`,
        ])
      ).exitCode === 0;
    if (imported) return;
    const pinned = git.manifest.sourceRevision;
    await this.import(
      git,
      repository,
      cwd,
      pinned?.repositoryId === repository.id ? pinned.commitSha : undefined,
    );
  }

  /** A local story branch starts at the imported source commit and is never reset. */
  async storyBranchStart(_git: WorkspaceGit, repository: WorkspaceRepository) {
    return [localSourceRef(repository)];
  }

  /** Exactly which host commits and configuration a turn ran against. */
  async turnEvidence(git: WorkspaceGit) {
    return {
      source: "local",
      projectManifestHash: git.manifest.hash,
      configurationRevision: git.manifest.sourceRevision ?? null,
      sourceRevisions: await workspaceSourceRevisions(this.db, git.orgId, git.workspace.id),
    };
  }

  /**
   * Explicitly imports the local repository's current default-branch commit as the
   * workspace's new source base. The story branch is never moved; the workspace's
   * copy of the default branch only fast-forwards when it has not diverged.
   */
  async refresh(git: WorkspaceGit, repositoryId: string) {
    const repository = git.repositories.find(
      (candidate) => candidate.id === repositoryId && candidate.source === "local",
    );
    if (!repository) {
      throw new ProjectEnvironmentError(
        "local_repository_not_found",
        "Local repository not found in this project",
      );
    }
    const cwd = repositoryPath(repository);
    const previous = (await workspaceSourceRevisions(this.db, git.orgId, git.workspace.id))[
      repositoryId
    ];
    if (!previous) {
      throw new ProjectEnvironmentError(
        "workspace_not_prepared",
        "The workspace has not imported this repository yet; start a turn first",
      );
    }
    const snapshot = await this.snapshot(git, repository);
    const result = {
      previous: previous.revision,
      revision: snapshot.commit,
      defaultBranchUpdated: false,
      diverged: false,
    };
    if (snapshot.commit === previous.revision) return result;
    await this.fetchBundle(git, repository, cwd, snapshot.bundle);
    // A rewritten host history must never rewind the workspace's default branch.
    result.diverged =
      (
        await git.probe(
          "git",
          ["merge-base", "--is-ancestor", previous.revision, snapshot.commit],
          cwd,
        )
      ).exitCode !== 0;
    if (!result.diverged) {
      const current = (await git.probe("git", ["branch", "--show-current"], cwd)).stdout.trim();
      const update =
        current === repository.defaultBranch
          ? ["merge", "--ff-only", "--quiet", localSourceRef(repository)]
          : [
              "update-ref",
              `refs/heads/${repository.defaultBranch}`,
              snapshot.commit,
              previous.revision,
            ];
      result.defaultBranchUpdated = (await git.probe("git", update, cwd)).exitCode === 0;
    }
    await this.recordSourceRevision(git, repository, snapshot.commit, previous.initialRevision);
    await appendWorkspaceEvent(this.db, git.workspace.id, git.orgId, "source.refreshed", {
      repositoryId: repository.id,
      repository: repository.name,
      ...result,
      warnings: snapshot.warnings,
    });
    return result;
  }

  /**
   * Imports a pinned local commit into a new workspace repository and records
   * the imported commit on the workspace.
   */
  private async import(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    revision?: string,
  ) {
    const snapshot = await this.snapshot(git, repository, revision);
    await git.run("git", ["init", "--quiet", cwd], ".", "local import");
    await this.fetchBundle(git, repository, cwd, snapshot.bundle);
    // Story branches live under facility/. A default branch named `facility` (or
    // inside facility/) would block them, so it is not materialized; the imported
    // source ref remains the base either way.
    await git.run(
      "git",
      storyNamespaceConflict(repository.defaultBranch)
        ? ["checkout", "--quiet", "--detach", localSourceRef(repository)]
        : ["checkout", "--quiet", "-B", repository.defaultBranch, localSourceRef(repository)],
      cwd,
      "local import",
    );
    await this.recordSourceRevision(git, repository, snapshot.commit);
    await appendWorkspaceEvent(this.db, git.workspace.id, git.orgId, "source.imported", {
      repositoryId: repository.id,
      repository: repository.name,
      branch: repository.defaultBranch,
      revision: snapshot.commit,
      warnings: snapshot.warnings,
    });
  }

  private async snapshot(git: WorkspaceGit, repository: WorkspaceRepository, revision?: string) {
    if (this.runtime.provider === "vercel") {
      throw new ProjectEnvironmentError(
        "local_source_requires_docker",
        "Local repositories run in Docker workspaces; set FACILITY_WORKSPACE_DRIVER=docker",
      );
    }
    return this.snapshots.snapshot(git.orgId, git.projectId, repository.id, revision);
  }

  private async fetchBundle(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    cwd: string,
    bundle: Buffer,
  ) {
    const staging = `.facility/imports/${randomUUID()}`;
    await git.run(
      "sh",
      ["-c", 'mkdir -p .facility/imports && : > "$1.b64"', "sh", staging],
      ".",
      "local import",
    );
    try {
      // Encoding chunk by chunk keeps every string small: a repository bundle can
      // exceed V8's maximum string length once base64-encoded as a whole.
      for (const chunk of base64Chunks(bundle)) {
        await git.run("sh", ["-c", 'cat >> "$1.b64"', "sh", staging], ".", "local import", chunk);
      }
      await git.run(
        "sh",
        ["-c", 'base64 -d "$1.b64" > "$1.bundle"', "sh", staging],
        ".",
        "local import",
      );
      await git.run(
        "git",
        [
          "fetch",
          "--quiet",
          "--no-tags",
          `${"../".repeat(cwd.split("/").length)}${staging}.bundle`,
          `+refs/facility/import:${localSourceRef(repository)}`,
        ],
        cwd,
        "local import",
      );
    } finally {
      await git.probe("rm", ["-f", `${staging}.b64`, `${staging}.bundle`]).catch(() => undefined);
    }
  }

  private async recordSourceRevision(
    git: WorkspaceGit,
    repository: WorkspaceRepository,
    revision: string,
    initialRevision = revision,
  ) {
    const entry = {
      [repository.id]: {
        revision,
        initialRevision,
        branch: repository.defaultBranch,
        importedAt: new Date().toISOString(),
      },
    };
    await this.db
      .update(workspaces)
      .set({
        sourceRevisions: sql`${workspaces.sourceRevisions} || ${JSON.stringify(entry)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(workspaces.orgId, git.orgId), eq(workspaces.id, git.workspace.id)));
  }
}

/** The source commits currently imported into a workspace, keyed by project repository id. */
export async function workspaceSourceRevisions(db: FacilityDb, orgId: string, workspaceId: string) {
  const row = (
    await db
      .select({ sourceRevisions: workspaces.sourceRevisions })
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspaceId)))
      .limit(1)
  )[0];
  return row?.sourceRevisions ?? {};
}

export function localSourceRef(repository: Pick<WorkspaceRepository, "defaultBranch">) {
  return `refs/facility/source/${repository.defaultBranch}`;
}

/** True when a branch name would occupy the ref namespace story branches are created in. */
export function storyNamespaceConflict(branch: string) {
  return branch === "facility" || branch.startsWith("facility/");
}

/**
 * Base64 encodes a buffer in pieces whose concatenation equals encoding it whole.
 * Raw slices are a multiple of 3 bytes, so no piece carries padding except the last.
 */
export function* base64Chunks(buffer: Buffer, rawChunkBytes = 3 * 1024 * 1024) {
  if (rawChunkBytes <= 0 || rawChunkBytes % 3 !== 0) {
    throw new RangeError("base64 chunks must be a positive multiple of 3 bytes");
  }
  for (let offset = 0; offset < buffer.length; offset += rawChunkBytes) {
    yield buffer.subarray(offset, offset + rawChunkBytes).toString("base64");
  }
}
