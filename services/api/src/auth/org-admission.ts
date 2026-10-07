import { type FacilityDb, githubInstallations, orgs } from "@facility/db";
import {
  type AnyColumn,
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";

/**
 * Whether an organization admits its members. A GitHub organization needs an
 * active App installation. A local-mode organization needs none, but a
 * suspended installation still blocks it: suspension is a revocation, and
 * local mode must not become a way around one.
 *
 * Local mode is an explicit `orgs.access_mode`, never inferred from missing
 * installation rows, so deleting an installation cannot admit an organization.
 */
export function orgAdmitsMembers(db: FacilityDb, orgId: AnyColumn) {
  const installations = (suspended: boolean) =>
    db
      .select({ one: sql`1` })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, orgId),
          suspended
            ? isNotNull(githubInstallations.suspendedAt)
            : isNull(githubInstallations.suspendedAt),
        ),
      );
  const localMode = db
    .select({ one: sql`1` })
    .from(orgs)
    .where(and(eq(orgs.id, orgId), eq(orgs.accessMode, "local")));
  return or(exists(installations(false)), and(exists(localMode), notExists(installations(true))));
}
