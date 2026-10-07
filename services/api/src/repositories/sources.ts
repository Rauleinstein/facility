import { type FacilityDb, projectRepositories } from "@facility/db";
import { and, asc, eq } from "drizzle-orm";
import {
  AgentCatalogError,
  type AgentCatalogSnapshot,
  type AgentCatalogSource,
} from "../agents/catalog.js";
import { isAgentManifestPath, isProjectSkillPath } from "../agents/catalog-files.js";
import type { GithubGitIdentity } from "../github/git-identity.js";
import type {
  RepositorySource,
  WorkspaceCredentials,
  WorkspaceRepository,
} from "../workspaces/credentials.js";
import {
  type PinnedRevisions,
  ProjectEnvironmentError,
  type ProjectManifest,
  type ProjectManifestSource,
  parseProjectManifest,
} from "../workspaces/project-environment.js";
import {
  DEFAULT_LOCAL_GIT_IDENTITY,
  LocalRepositoryError,
  type LocalRepositoryHost,
} from "./local.js";
import type { LocalSnapshotProvider } from "./local-workspace.js";

export type { RepositorySource };
export { DEFAULT_LOCAL_GIT_IDENTITY };
export type ProjectRepositoryRow = typeof projectRepositories.$inferSelect;

/** Local repositories share one owner sentinel that GitHub logins cannot use. */
export const LOCAL_REPOSITORY_OWNER = "_local";

/** Repository access that a workspace needs before preparation. */
export interface RepositoryAccess {
  issue(orgId: string, projectId: string): Promise<WorkspaceCredentials>;
}

export async function projectRepositoryRows(db: FacilityDb, orgId: string, projectId: string) {
  return db
    .select()
    .from(projectRepositories)
    .where(and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)))
    .orderBy(
      asc(projectRepositories.role),
      asc(projectRepositories.owner),
      asc(projectRepositories.name),
    );
}

/**
 * The project's repository source is its primary repository's source. Projects
 * never mix sources: a local workflow must not depend on GitHub credentials, and
 * a GitHub workflow keeps its existing single-provider contract.
 */
export function projectSource(rows: Array<Pick<ProjectRepositoryRow, "role" | "source">>) {
  const sources = new Set(rows.map((row) => row.source));
  if (sources.size > 1) {
    throw new ProjectEnvironmentError(
      "repository_sources_mixed",
      "A project's repositories must all be GitHub repositories or all be local repositories",
    );
  }
  return (rows.find((row) => row.role === "primary")?.source ?? "github") as RepositorySource;
}

export async function loadProjectSource(db: FacilityDb, orgId: string, projectId: string) {
  return projectSource(await projectRepositoryRows(db, orgId, projectId));
}

/** Repository access, configuration and agent catalog for one repository source. */
export type RepositorySourceServices = {
  access: RepositoryAccess;
  manifests: ProjectManifestSource;
  catalog: AgentCatalogSource;
};

/**
 * The one place that picks a project's repository source. Each project-scoped
 * service resolves the project's source and delegates to that source's
 * implementation, so a local project never reaches GitHub.
 */
export class ProjectRepositorySources {
  readonly access: RepositoryAccess;
  readonly manifests: ProjectManifestSource;
  readonly catalog: AgentCatalogSource;

  constructor(db: FacilityDb, sources: Record<RepositorySource, RepositorySourceServices>) {
    const of = async (orgId: string, projectId: string) =>
      sources[await loadProjectSource(db, orgId, projectId)];
    this.access = {
      issue: async (orgId, projectId) =>
        (await of(orgId, projectId)).access.issue(orgId, projectId),
    };
    this.manifests = {
      load: async (orgId, projectId, pinned) =>
        (await of(orgId, projectId)).manifests.load(orgId, projectId, pinned),
    };
    this.catalog = {
      load: async (orgId, projectId) => (await of(orgId, projectId)).catalog.load(orgId, projectId),
      proposeUpdate: async (orgId, projectId, input) => {
        const { catalog } = await of(orgId, projectId);
        if (!catalog.proposeUpdate) {
          throw new AgentCatalogError(
            "agent_catalog_read_only",
            "This agent catalog source does not support Git proposals",
            501,
          );
        }
        return catalog.proposeUpdate(orgId, projectId, input);
      },
    };
  }
}

/** Local preparation needs no repository credential. Model credentials stay separate. */
export class LocalRepositoryAccess implements RepositoryAccess {
  constructor(
    private readonly db: FacilityDb,
    private readonly identity: GithubGitIdentity = DEFAULT_LOCAL_GIT_IDENTITY,
  ) {}

  async issue(orgId: string, projectId: string): Promise<WorkspaceCredentials> {
    const rows = await projectRepositoryRows(this.db, orgId, projectId);
    if (!rows.some((row) => row.role === "primary")) {
      throw new ProjectEnvironmentError(
        "project_repositories_missing",
        "project must have one primary repository",
      );
    }
    return {
      source: "local",
      repositories: rows.map(
        (row): WorkspaceRepository => ({
          id: row.id,
          source: "local",
          owner: row.owner,
          name: row.name,
          defaultBranch: row.defaultBranch,
          role: row.role as "primary" | "related",
        }),
      ),
      environment: {},
      expiresAt: new Date(8_640_000_000_000_000),
      gitIdentity: this.identity,
    };
  }
}

/** Resolves and packages committed history from registered local repositories. */
export class LocalRepositorySnapshots implements LocalSnapshotProvider {
  constructor(
    private readonly db: FacilityDb,
    readonly host: LocalRepositoryHost,
  ) {}

  async repository(orgId: string, projectId: string, repositoryId?: string) {
    const row = (
      await this.db
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.orgId, orgId),
            eq(projectRepositories.projectId, projectId),
            repositoryId
              ? eq(projectRepositories.id, repositoryId)
              : eq(projectRepositories.role, "primary"),
          ),
        )
        .limit(1)
    )[0];
    if (row?.source !== "local" || !row.sourcePath || !row.sourceRepository) {
      throw new LocalRepositoryError(
        "local_repository_not_found",
        "Local repository not found in this project",
        404,
      );
    }
    return { ...row, sourcePath: row.sourcePath, sourceRepository: row.sourceRepository };
  }

  async resolve(orgId: string, projectId: string, repositoryId?: string) {
    const row = await this.repository(orgId, projectId, repositoryId);
    return { row, commit: await this.host.resolve(row, row.defaultBranch) };
  }

  async snapshot(orgId: string, projectId: string, repositoryId: string, commit?: string) {
    const row = await this.repository(orgId, projectId, repositoryId);
    const revision = commit ?? (await this.host.resolve(row, row.defaultBranch));
    const [bundle, warnings] = await Promise.all([
      this.host.snapshot(row, revision),
      this.host.warnings(row, revision),
    ]);
    return { commit: revision, branch: row.defaultBranch, bundle, warnings };
  }
}

/**
 * Reads `.facility.yml` from the primary repository at one commit: the story's
 * imported revision when there is one, otherwise the default branch's head.
 */
export class LocalProjectManifestSource implements ProjectManifestSource {
  constructor(private readonly snapshots: LocalRepositorySnapshots) {}

  async load(orgId: string, projectId: string, pinned?: PinnedRevisions): Promise<ProjectManifest> {
    const row = await this.snapshots.repository(orgId, projectId);
    const commit =
      pinned?.[row.id]?.revision ?? (await this.snapshots.host.resolve(row, row.defaultBranch));
    const source = await this.snapshots.host.readFile(row, commit, ".facility.yml");
    if (source === undefined) {
      throw new ProjectEnvironmentError(
        "project_manifest_not_found",
        `primary repository must contain .facility.yml on ${row.defaultBranch}`,
      );
    }
    return {
      ...parseProjectManifest(source),
      sourceRevision: { repositoryId: row.id, commitSha: commit },
    };
  }
}

/** Reads the committed `.agents` catalog and skills from a local repository. */
export class LocalAgentCatalogSource implements AgentCatalogSource {
  constructor(private readonly snapshots: LocalRepositorySnapshots) {}

  async load(orgId: string, projectId: string): Promise<AgentCatalogSnapshot> {
    try {
      const { row, commit } = await this.snapshots.resolve(orgId, projectId);
      const files = await this.snapshots.host.files(
        row,
        commit,
        [".agents", ".claude/skills"],
        (path) => isAgentManifestPath(path) || isProjectSkillPath(path),
      );
      const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
      return {
        commitSha: commit,
        sources: entries
          .filter(([path]) => isAgentManifestPath(path))
          .map(([file, source]) => ({ file, source })),
        skills: entries
          .filter(([path]) => isProjectSkillPath(path))
          .map(([file, source]) => ({ file, source })),
      };
    } catch (error) {
      if (error instanceof LocalRepositoryError && error.statusCode === 404) {
        throw new AgentCatalogError("primary_repository_not_found", error.message, 404);
      }
      // Access refusals are never softened into a cached, "temporarily unavailable" read.
      if (error instanceof LocalRepositoryError && [403, 409].includes(error.statusCode)) {
        throw new AgentCatalogError(error.code, error.message, error.statusCode);
      }
      // A temporarily unavailable host path falls back to the last validated projection.
      throw new AgentCatalogError(
        "agent_catalog_unavailable",
        error instanceof Error
          ? `Agent catalog could not be read from the local repository: ${error.message}`
          : "Agent catalog could not be read from the local repository",
        503,
      );
    }
  }

  /** The committed catalog is the source of truth; Facility never writes to it. */
  async proposeUpdate(): Promise<never> {
    throw new AgentCatalogError(
      "agent_catalog_read_only",
      "Edit .agents/ in the local repository and commit the change; Facility reads the committed catalog",
      501,
    );
  }
}
