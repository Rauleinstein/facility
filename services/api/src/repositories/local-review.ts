import { createHash } from "node:crypto";
import { newId } from "@facility/core";
import {
  type FacilityDb,
  stories,
  storyEvidenceEvents,
  storyExports,
  turns,
  workspaces,
} from "@facility/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { appendStoryEvidence } from "../stories/evidence.js";
import { parseGitLog, parseNameStatus } from "../turns/git-evidence.js";
import { readWorkspaceLocator } from "../workspaces/locator.js";
import {
  type ProjectEnvironmentService,
  type ProjectManifestSource,
  repositoryPath,
} from "../workspaces/project-environment.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";
import {
  currentChecks,
  LOCAL_CHECK_COMPLETED,
  LOCAL_REVIEW_APPROVED,
  LOCAL_REVIEW_CHANGES_REQUESTED,
  LOCAL_REVIEW_TYPES,
  type LocalReviewStatus,
  latestReview,
  reviewStatus,
} from "./local-review-rules.js";
import { type LocalWorkspaceSource, localSourceRef } from "./local-workspace.js";
import { loadProjectSource, type RepositoryAccess } from "./sources.js";

const MAX_COMMITS = 500;
const MAX_CHANGED_FILES = 2_000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

export type ReviewActor = { type: "user" | "service" | "system"; id: string };

/** An API error whose code and message are part of the local review contract. */
export class LocalReviewError extends ApiError {
  constructor(code: string, message: string, statusCode = 409) {
    super(statusCode, code, message, undefined, true);
    this.name = "LocalReviewError";
  }
}

/**
 * Review, checks, source refresh and export for stories whose project uses a
 * local repository. Approval is recorded against one exact commit: any later
 * commit or uncommitted change makes it stale, and only an approved, clean head
 * can be exported. Exporting never merges into the user's repository.
 */
export class LocalReviewService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    /** Local repository access only: this surface never reaches GitHub. */
    private readonly credentials: RepositoryAccess,
    private readonly manifests: ProjectManifestSource,
    private readonly environment: ProjectEnvironmentService,
    private readonly localWorkspace: LocalWorkspaceSource,
  ) {}

  async state(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { wake: boolean } = { wake: true },
  ) {
    const context = await this.context(orgId, projectId, storyId, options);
    return this.describe(context);
  }

  async approve(
    input: { orgId: string; projectId: string; storyId: string; commitSha: string; note?: string },
    actor: ReviewActor,
    options: { wake: boolean } = { wake: true },
  ) {
    const context = await this.context(input.orgId, input.projectId, input.storyId, options);
    await this.assertIdle(context);
    const state = await this.describe(context);
    if (state.headSha !== input.commitSha) {
      throw new LocalReviewError(
        "review_commit_mismatch",
        `The story is now at ${state.headSha.slice(0, 12)}; review the latest changes before approving`,
      );
    }
    // Approval is what this request supplies; every other blocker still applies.
    assertUnblocked(state, ["approval_required"]);
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      source: "facility",
      type: LOCAL_REVIEW_APPROVED,
      data: {
        repositoryId: context.repository.id,
        branch: state.branch,
        baseSha: state.baseSha,
        commitSha: state.headSha,
        note: input.note ?? null,
        reviewer: actor,
      },
    });
    return this.describe(context);
  }

  async requestChanges(
    input: {
      orgId: string;
      projectId: string;
      storyId: string;
      commitSha?: string;
      note: string;
    },
    actor: ReviewActor,
    options: { wake: boolean } = { wake: true },
  ) {
    const context = await this.context(input.orgId, input.projectId, input.storyId, options);
    const state = await this.describe(context);
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      source: "facility",
      type: LOCAL_REVIEW_CHANGES_REQUESTED,
      data: {
        repositoryId: context.repository.id,
        branch: state.branch,
        commitSha: input.commitSha ?? state.headSha,
        note: input.note,
        reviewer: actor,
      },
    });
    return this.describe(context);
  }

  async runChecks(input: { orgId: string; projectId: string; storyId: string }) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    // Check commands come from the configuration the story imported, not the host's head.
    const manifest = await this.manifests.load(
      input.orgId,
      input.projectId,
      context.workspace.sourceRevisions,
    );
    const outcome = await this.environment.runChecks({
      orgId: input.orgId,
      projectId: input.projectId,
      workspace: context.locator,
      manifest,
      credentials: context.credentials,
    });
    for (const result of outcome.results) {
      await appendStoryEvidence(this.db, {
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        source: "workspace",
        type: LOCAL_CHECK_COMPLETED,
        data: {
          repositoryId: context.repository.id,
          commitSha: outcome.commitSha,
          dirty: outcome.dirty,
          commitChanged: outcome.commitChanged,
          ...result,
        },
      });
    }
    return this.describe(context);
  }

  async refreshSource(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    repositoryId?: string;
  }) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    const manifest = await this.manifests.load(input.orgId, input.projectId);
    const refreshed = await this.localWorkspace.refresh(
      this.environment.workspaceGit({
        orgId: input.orgId,
        projectId: input.projectId,
        workspace: context.locator,
        manifest,
        credentials: context.credentials,
      }),
      input.repositoryId ?? context.repository.id,
    );
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      source: "workspace",
      type: "local_source.refreshed",
      data: { repositoryId: input.repositoryId ?? context.repository.id, ...refreshed },
    });
    // The recorded source revision changed; describe the refreshed workspace.
    const current = await this.context(input.orgId, input.projectId, input.storyId);
    return { ...(await this.describe(current)), refresh: refreshed };
  }

  async createExport(
    input: { orgId: string; projectId: string; storyId: string },
    actor: ReviewActor,
  ) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    const state = await this.describe(context);
    assertUnblocked(state);
    const reviewEventId = state.approval.eventId;
    if (!reviewEventId) throw blockerError(state, "approval_required");
    const id = newId("sexp");
    // Staged at the workspace root, outside the repository; git gets it as an absolute path.
    const file = `.facility/exports/${id}.bundle`;
    await this.exec(context, "mkdir", ["-p", ".facility/exports"], ".");
    try {
      const bundlePath = `${(await this.exec(context, "pwd", [], ".")).trim()}/${file}`;
      await this.git(context, [
        "bundle",
        "create",
        "--quiet",
        bundlePath,
        `refs/heads/${state.branch}`,
        `^${state.baseSha}`,
      ]);
      await this.git(context, ["bundle", "verify", "--quiet", bundlePath]);
      // A turn may have committed after the approval was checked; export only the approved commit.
      const heads = await this.git(context, ["bundle", "list-heads", bundlePath]);
      if (heads.split(/\s+/)[0] !== state.headSha) {
        throw new LocalReviewError(
          "review_commit_mismatch",
          "The story branch moved while exporting; review the latest changes and approve them",
        );
      }
      const size = Number(await this.exec(context, "stat", ["-c", "%s", file], "."));
      if (!(size > 0 && size <= MAX_EXPORT_BYTES)) {
        throw new LocalReviewError(
          "export_too_large",
          `The export bundle must be between 1 and ${MAX_EXPORT_BYTES} bytes`,
          413,
        );
      }
      const encoded = (await this.exec(context, "base64", [file], ".")).replace(/\s+/g, "");
      const bundle = Buffer.from(encoded, "base64");
      const patch = await this.git(context, [
        "format-patch",
        "--stdout",
        "--binary",
        `${state.baseSha}..${state.headSha}`,
      ]);
      const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
      // The export and its evidence are recorded together or not at all.
      const row = await this.db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        const inserted = (
          await tx
            .insert(storyExports)
            .values({
              id,
              orgId: input.orgId,
              projectId: input.projectId,
              storyId: input.storyId,
              repositoryId: context.repository.id,
              reviewEventId,
              branch: state.branch,
              baseSha: state.baseSha,
              headSha: state.headSha,
              commitCount: state.commits.length,
              bundle,
              bundleSha256,
              patch,
              createdBy: actor,
            })
            .returning(exportColumns)
        )[0];
        if (!inserted)
          throw new LocalReviewError("export_failed", "The export could not be saved", 500);
        await appendStoryEvidence(tx, {
          orgId: input.orgId,
          projectId: input.projectId,
          storyId: input.storyId,
          source: "facility",
          type: "local_export.created",
          data: {
            exportId: id,
            repositoryId: context.repository.id,
            baseSha: state.baseSha,
            headSha: state.headSha,
            commitCount: state.commits.length,
            bundleSha256,
          },
        });
        return inserted;
      });
      return {
        ...(await this.describe(context)),
        export: presentExport(row, context.repository.defaultBranch),
      };
    } finally {
      await this.exec(context, "rm", ["-f", file], ".").catch(() => undefined);
    }
  }

  async exportFile(input: { orgId: string; projectId: string; storyId: string; exportId: string }) {
    const row = (
      await this.db
        .select()
        .from(storyExports)
        .where(
          and(
            eq(storyExports.orgId, input.orgId),
            eq(storyExports.projectId, input.projectId),
            eq(storyExports.storyId, input.storyId),
            eq(storyExports.id, input.exportId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new LocalReviewError("export_not_found", "Export not found", 404);
    return row;
  }

  private async context(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { wake: boolean } = { wake: true },
  ) {
    // Checked first: a GitHub project must never mint GitHub credentials for this surface.
    if ((await loadProjectSource(this.db, orgId, projectId)) !== "local") {
      throw new LocalReviewError(
        "local_review_unavailable",
        "Local review applies to projects backed by a local repository; GitHub projects review through pull requests",
      );
    }
    const story = (
      await this.db
        .select()
        .from(stories)
        .where(
          and(eq(stories.orgId, orgId), eq(stories.projectId, projectId), eq(stories.id, storyId)),
        )
        .limit(1)
    )[0];
    if (!story || story.deletedAt) {
      throw new LocalReviewError("story_not_found", "Story not found", 404);
    }
    const credentials = await this.credentials.issue(orgId, projectId);
    const repository = credentials.repositories.find((candidate) => candidate.role === "primary");
    if (!repository) {
      throw new LocalReviewError(
        "repository_not_found",
        "The project has no primary repository",
        404,
      );
    }
    const workspace = (
      await this.db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgId),
            eq(workspaces.projectId, projectId),
            eq(workspaces.storyId, storyId),
            inArray(workspaces.state, ["creating", "running", "sleeping", "error"]),
          ),
        )
        .limit(1)
    )[0];
    if (!workspace?.externalRef) {
      throw new LocalReviewError("workspace_not_found", "The story has no workspace yet", 404);
    }
    const imported = workspace.sourceRevisions[repository.id];
    if (!story.branch || !imported) {
      throw new LocalReviewError(
        "workspace_not_prepared",
        "The workspace has not imported the repository yet; wait for the first turn to start",
      );
    }
    const locator = workspaceLocator(workspace);
    if (workspace.state !== "running") {
      if (!options.wake) {
        throw new LocalReviewError(
          "workspace_not_running",
          "The workspace is suspended. Someone who can run workspaces must open the review to wake it.",
        );
      }
      await this.runtime.wake(locator);
      await this.db
        .update(workspaces)
        .set({ state: "running", error: null, lastActivityAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspace.id)));
    }
    return {
      orgId,
      projectId,
      story,
      branch: story.branch,
      workspace,
      locator,
      credentials,
      repository,
      imported,
      cwd: repositoryPath(repository),
    };
  }

  private async describe(context: Awaited<ReturnType<LocalReviewService["context"]>>) {
    const sourceRef = localSourceRef(context.repository);
    const [headSha, currentBranch, status] = await Promise.all([
      this.git(context, ["rev-parse", "HEAD"]),
      this.git(context, ["branch", "--show-current"]),
      this.git(context, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const branchHead = await this.git(context, ["rev-parse", `refs/heads/${context.branch}`]).catch(
      () => headSha,
    );
    const baseSha = await this.git(context, ["merge-base", branchHead, sourceRef]);
    const [log, diff] = await Promise.all([
      this.git(context, [
        "log",
        "--reverse",
        `--max-count=${MAX_COMMITS}`,
        "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
        branchHead,
        "--not",
        baseSha,
      ]),
      this.git(context, ["diff", "--name-status", "-z", baseSha, branchHead, "--"]),
    ]);
    const commits = parseGitLog(log);
    const changedFiles = parseNameStatus(diff).slice(0, MAX_CHANGED_FILES);
    const uncommitted = status
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ status: entry.slice(0, 2).trim(), path: entry.slice(3) }))
      .filter((entry) => entry.path)
      .slice(0, MAX_CHANGED_FILES);
    const dirty = uncommitted.length > 0;

    const [reviewRows, checkRows, exportRows] = await Promise.all([
      this.db
        .select()
        .from(storyEvidenceEvents)
        .where(
          and(
            eq(storyEvidenceEvents.orgId, context.orgId),
            eq(storyEvidenceEvents.storyId, context.story.id),
            inArray(storyEvidenceEvents.type, LOCAL_REVIEW_TYPES),
          ),
        )
        .orderBy(desc(storyEvidenceEvents.occurredAt), desc(storyEvidenceEvents.observedAt))
        .limit(20),
      this.db
        .select()
        .from(storyEvidenceEvents)
        .where(
          and(
            eq(storyEvidenceEvents.orgId, context.orgId),
            eq(storyEvidenceEvents.storyId, context.story.id),
            eq(storyEvidenceEvents.type, LOCAL_CHECK_COMPLETED),
          ),
        )
        .orderBy(desc(storyEvidenceEvents.occurredAt))
        .limit(200),
      this.db
        .select(exportColumns)
        .from(storyExports)
        .where(
          and(
            eq(storyExports.orgId, context.orgId),
            eq(storyExports.projectId, context.projectId),
            eq(storyExports.storyId, context.story.id),
          ),
        )
        .orderBy(desc(storyExports.createdAt))
        .limit(50),
    ]);

    const review = latestReview(reviewRows);
    const approvalStatus = reviewStatus(review, {
      sha: branchHead,
      clean: headSha === branchHead && !dirty,
    });
    const checks = [...currentChecks(checkRows, branchHead).values()].map(({ event, data }) => ({
      ...data,
      recordedAt: event.occurredAt,
    }));

    const blockers: LocalReviewBlocker[] = [];
    if (currentBranch !== context.branch) blockers.push("story_branch_not_checked_out");
    if (dirty) blockers.push("uncommitted_changes");
    if (commits.length === 0) blockers.push("no_changes");
    if (approvalStatus !== "approved") blockers.push("approval_required");

    return {
      repository: {
        id: context.repository.id,
        name: context.repository.name,
        defaultBranch: context.repository.defaultBranch,
      },
      branch: context.branch,
      currentBranch,
      headSha: branchHead,
      baseSha,
      sourceRevision: context.imported.revision,
      initialSourceRevision: context.imported.initialRevision,
      sourceImportedAt: context.imported.importedAt,
      dirty,
      uncommitted,
      commits,
      changedFiles,
      approval: {
        status: approvalStatus,
        commitSha: review?.data.commitSha ?? null,
        note: review?.data.note ?? null,
        reviewer: review?.data.reviewer ?? null,
        reviewedAt: review?.event.occurredAt ?? null,
        eventId: review?.approved ? review.event.id : null,
      },
      checks,
      exports: exportRows.map((row) => presentExport(row, context.repository.defaultBranch)),
      exportable: blockers.length === 0,
      blockers,
    };
  }

  private async assertIdle(context: { orgId: string; projectId: string; story: { id: string } }) {
    const active = await this.db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.orgId, context.orgId),
          eq(turns.projectId, context.projectId),
          eq(turns.storyId, context.story.id),
          inArray(turns.state, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      throw new LocalReviewError(
        "turn_active",
        "An agent turn is queued or running; wait for it to finish",
      );
    }
  }

  private async git(context: { locator: WorkspaceLocator; cwd: string }, args: string[]) {
    return (await this.exec(context, "git", args, context.cwd)).trim();
  }

  private async exec(
    context: { locator: WorkspaceLocator },
    command: string,
    args: string[],
    cwd: string,
  ) {
    const result = await this.runtime.exec(context.locator, {
      command,
      args,
      cwd,
      timeoutMs: 10 * 60 * 1_000,
    });
    if (result.exitCode !== 0) {
      throw new LocalReviewError(
        "workspace_git_failed",
        `${command} ${args[0] ?? ""} failed: ${result.stderr.trim().slice(-2_000)}`,
      );
    }
    return result.stdout;
  }
}

const exportColumns = {
  id: storyExports.id,
  repositoryId: storyExports.repositoryId,
  reviewEventId: storyExports.reviewEventId,
  branch: storyExports.branch,
  baseSha: storyExports.baseSha,
  headSha: storyExports.headSha,
  commitCount: storyExports.commitCount,
  bundleSha256: storyExports.bundleSha256,
  createdBy: storyExports.createdBy,
  createdAt: storyExports.createdAt,
};

type ExportRow = {
  id: string;
  branch: string;
  baseSha: string;
  headSha: string;
  commitCount: number;
  bundleSha256: string;
  createdBy: unknown;
  createdAt: Date;
};

export function exportReviewBranch(row: { id: string; branch: string }) {
  return `facility-review/${row.branch.replace(/^facility\//, "")}-${row.id}`;
}

function presentExport(row: ExportRow, defaultBranch: string) {
  const reviewBranch = exportReviewBranch(row);
  const bundleFile = `${row.id}.bundle`;
  return {
    id: row.id,
    branch: row.branch,
    baseSha: row.baseSha,
    headSha: row.headSha,
    commitCount: row.commitCount,
    bundleSha256: row.bundleSha256,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    reviewBranch,
    // Importing creates a new branch in the user's repository and leaves the checked-out
    // branch and working tree alone. Merging stays their decision. Save the downloaded
    // files outside the repository so they never appear as untracked files.
    instructions: [
      `git fetch /path/to/${bundleFile} "refs/heads/${row.branch}:refs/heads/${reviewBranch}"`,
      `git log --oneline ${defaultBranch}..${reviewBranch}`,
      `git merge ${reviewBranch}   # when you are ready; resolve any conflicts as usual`,
    ],
    patchInstructions: [
      `git switch -c ${reviewBranch} ${row.baseSha}`,
      `git am /path/to/${row.id}.patch`,
    ],
  };
}

type LocalReviewBlocker =
  | "story_branch_not_checked_out"
  | "uncommitted_changes"
  | "no_changes"
  | "approval_required";

type ReviewState = {
  branch: string;
  currentBranch: string;
  approval: { status: LocalReviewStatus };
  blockers: LocalReviewBlocker[];
};

const BLOCKER_MESSAGES: Record<LocalReviewBlocker, (state: ReviewState) => string> = {
  story_branch_not_checked_out: (state) =>
    `The workspace is on ${state.currentBranch || "a detached HEAD"}, not the story branch ${state.branch}`,
  uncommitted_changes: () =>
    "The workspace has uncommitted changes. Ask the agent to commit or discard them first.",
  no_changes: () => "The story branch has no commits yet",
  approval_required: () => "Approve the story's latest commit before exporting it",
};

/** The error for one blocker; a stale approval says why it no longer counts. */
function blockerError(state: ReviewState, blocker: LocalReviewBlocker) {
  if (blocker === "approval_required" && state.approval.status === "stale") {
    return new LocalReviewError(
      "approval_stale",
      "The approved commit is no longer the story's head; review and approve the latest changes",
    );
  }
  return new LocalReviewError(blocker, BLOCKER_MESSAGES[blocker](state));
}

/** Throws the first blocker that `waived` does not cover. */
function assertUnblocked(state: ReviewState, waived: LocalReviewBlocker[] = []) {
  const blocker = state.blockers.find((candidate) => !waived.includes(candidate));
  if (blocker) throw blockerError(state, blocker);
}

function workspaceLocator(row: typeof workspaces.$inferSelect): WorkspaceLocator {
  const locator = readWorkspaceLocator(row);
  if (!locator) throw new LocalReviewError("workspace_not_ready", "Workspace is not ready");
  return locator;
}
