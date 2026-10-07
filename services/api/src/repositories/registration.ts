import { basename } from "node:path";
import { newId } from "@facility/core";
import { type FacilityDb, projectRepositories } from "@facility/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { isLocalAlias, type LocalRepositoryHost } from "./local.js";
import { assertProjectSource, LOCAL_REPOSITORY_OWNER } from "./sources.js";

/**
 * Registers a host repository with a project. Validation reads Git metadata
 * only; no hook, setup, or repository command runs. The project's first
 * repository becomes its primary one.
 */
export async function registerLocalRepository(
  db: FacilityDb,
  host: LocalRepositoryHost,
  input: { orgId: string; projectId: string; path: string; alias?: string; defaultBranch?: string },
) {
  const inspection = await host.inspect(input.path, input.defaultBranch);
  const alias = input.alias ?? basename(inspection.path).replace(/\.git$/i, "");
  if (!isLocalAlias(alias)) {
    throw new ApiError(
      400,
      "local_repository_alias_invalid",
      "Use an alias of letters, digits, '.', '_' or '-' that does not end in .git",
    );
  }
  const row = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as FacilityDb;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.orgId}:${input.projectId}`}))`,
    );
    // One organization owns a host repository, through any of its paths or
    // worktrees. The database trigger enforces this; the check gives a clear error.
    const claimed = await tx
      .select({ id: projectRepositories.id })
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.source, "local"),
          eq(projectRepositories.sourceRepository, inspection.repositoryKey),
          ne(projectRepositories.orgId, input.orgId),
        ),
      )
      .limit(1);
    if (claimed.length > 0) {
      throw new ApiError(
        409,
        "local_repository_claimed",
        "This repository is registered by another organization",
      );
    }
    const existing = await tx
      .select({
        role: projectRepositories.role,
        source: projectRepositories.source,
        name: projectRepositories.name,
        sourceRepository: projectRepositories.sourceRepository,
      })
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, input.orgId),
          eq(projectRepositories.projectId, input.projectId),
        ),
      );
    assertProjectSource(existing, "local");
    if (
      existing.some(
        (repository) =>
          repository.sourceRepository === inspection.repositoryKey ||
          repository.name.toLowerCase() === alias.toLowerCase(),
      )
    ) {
      throw new ApiError(
        409,
        "local_repository_exists",
        "This project already has a local repository with that path or alias",
      );
    }
    return (
      await tx
        .insert(projectRepositories)
        .values({
          id: newId("repo"),
          orgId: input.orgId,
          projectId: input.projectId,
          installationId: null,
          owner: LOCAL_REPOSITORY_OWNER,
          name: alias,
          defaultBranch: inspection.defaultBranch,
          role: existing.some((repository) => repository.role === "primary")
            ? "related"
            : "primary",
          source: "local",
          sourcePath: inspection.path,
          sourceRepository: inspection.repositoryKey,
        })
        .returning()
    )[0];
  });
  if (!row) throw new ApiError(500, "insert_failed", "Could not register repository");
  return { row, inspection };
}
