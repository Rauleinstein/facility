import { randomBytes } from "node:crypto";
import { newId, open, seal } from "@facility/core";
import { githubInstallations, orgMembers, orgs, roles, userIdentities, users } from "@facility/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mintSessionCookie } from "../app.js";
import { type AuthTransaction, ExternalIdentityProvider } from "../auth/identity-provider.js";
import { orgAdmitsMembers } from "../auth/org-admission.js";
import { safeReturnTo } from "../auth/return-to.js";
import { ApiError } from "../errors.js";
import type {
  AppConfig,
  ExternalIdentity,
  GithubExternalIdentity,
  OidcExternalIdentity,
} from "../types.js";

const EmptyResponse = z.object({ ok: z.boolean() });
const STATE_COOKIE = "facility_oauth_state";
const SESSION_COOKIE = "facility_session";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: { fetch?: typeof fetch } = {},
) {
  const provider = new ExternalIdentityProvider(config, options.fetch);

  app.get(
    "/auth/login",
    {
      config: { public: true },
      schema: {
        querystring: z.object({ returnTo: z.string().optional() }),
        response: { 302: z.unknown(), 501: z.object({ error: z.unknown() }) },
      },
    },
    async (request, reply) => {
      const { returnTo } = request.query as { returnTo?: string };
      const transaction: AuthTransaction = {
        state: randomBytes(24).toString("base64url"),
        verifier: randomBytes(48).toString("base64url"),
        nonce: randomBytes(24).toString("base64url"),
        returnTo: safeReturnTo(returnTo),
      };
      const sealed = await seal(JSON.stringify(transaction), config.secretMasterKey);
      reply.setCookie(STATE_COOKIE, sealed, cookieOptions(config, 600));
      return reply.redirect(await provider.authorizationUrl(transaction));
    },
  );

  app.get(
    "/auth/callback",
    {
      config: { public: true },
      schema: {
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
        response: { 302: z.unknown(), 401: z.unknown(), 403: z.unknown(), 501: z.unknown() },
      },
    },
    async (request, reply) => {
      const query = request.query as { code?: string; state?: string; error?: string };
      if (query.error) throw new ApiError(401, "auth_denied", "Authentication was denied");
      if (!query.code) throw new ApiError(401, "missing_code", "Authorization code is required");
      const stateCookie = request.cookies[STATE_COOKIE];
      let transaction: AuthTransaction;
      try {
        transaction = z
          .object({
            state: z.string(),
            verifier: z.string(),
            nonce: z.string(),
            returnTo: z.string(),
          })
          .parse(JSON.parse(await open(stateCookie ?? "", config.secretMasterKey)));
      } catch {
        throw new ApiError(401, "bad_state", "OAuth state is missing or invalid");
      }
      if (transaction.state !== query.state)
        throw new ApiError(401, "bad_state", "OAuth state mismatch");
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      let identity: ExternalIdentity;
      try {
        identity = await provider.exchange(query.code, transaction);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        request.log.warn({ err: error }, "external identity exchange failed");
        throw new ApiError(401, "auth_failed", "Authentication failed");
      }
      const session = await ensureExternalUser(app.facilityDb, identity);
      reply.setCookie(
        SESSION_COOKIE,
        await mintSessionCookie(config, session.userId, session.orgId),
        cookieOptions(config, 7 * 24 * 60 * 60),
      );
      request.log.info(
        {
          action: "auth.login",
          actor: { type: "user", id: session.userId },
          orgId: session.orgId,
          via: config.authIdentityProvider ?? "github",
        },
        "facility access event",
      );
      return reply.redirect(
        new URL(transaction.returnTo, config.webUrl ?? config.publicUrl).toString(),
      );
    },
  );

  app.post(
    "/auth/logout",
    { config: { public: true }, schema: { response: { 200: EmptyResponse } } },
    async (request, reply) => {
      if (request.principal)
        await request.audit("auth.logout", {
          type: request.principal.type,
          id: request.principal.id,
        });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    },
  );

  app.get(
    "/auth/default-org",
    {
      config: { permission: "org:read" },
      schema: { response: { 200: z.object({ id: z.string(), slug: z.string() }) } },
    },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw new ApiError(401, "unauthorized", "Authentication required");
      const org = (
        await app.facilityDb.select().from(orgs).where(eq(orgs.id, principal.orgId)).limit(1)
      )[0];
      if (!org) throw new ApiError(404, "not_found", "Organization not found");
      return { id: org.id, slug: org.slug };
    },
  );
}

/** Resolve a verified external identity to an explicitly provisioned Facility member. */
export async function ensureExternalUser(
  db: FastifyInstance["facilityDb"],
  identity: ExternalIdentity,
): Promise<{ userId: string; orgId: string }> {
  return db.transaction((transaction) => {
    const tx = transaction as unknown as FastifyInstance["facilityDb"];
    return identity.provider === "github"
      ? ensureGithubUserTransaction(tx, identity)
      : ensureOidcUserTransaction(tx, identity);
  });
}

/**
 * The invited Facility user for an identity: the user already linked to it, or
 * else the one active user whose email the identity provider verified.
 */
async function invitedUser(
  db: FastifyInstance["facilityDb"],
  identity: { provider: string; subject: string; verifiedEmails: string[]; label: string },
) {
  const linked = (
    await db
      .select({ identity: userIdentities, user: users })
      .from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .where(
        and(
          eq(userIdentities.provider, identity.provider),
          eq(userIdentities.providerSubject, identity.subject),
        ),
      )
      .limit(1)
  )[0];
  const emailMatches = linked
    ? []
    : await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.status, "active"),
            inArray(sql`lower(${users.email})`, identity.verifiedEmails),
          ),
        )
        .limit(2);
  if (!linked && emailMatches.length > 1) {
    throw new ApiError(
      403,
      "identity_conflict",
      `Multiple Facility users match verified ${identity.label} emails`,
    );
  }
  const invited = linked?.user ?? emailMatches[0];
  if (invited?.status !== "active") {
    throw new ApiError(
      403,
      "not_invited",
      `No active Facility invitation exists for this ${identity.label} user`,
    );
  }
  return { linked, invited };
}

/** Links an identity to the invited user once; a user holds one identity per provider. */
async function linkIdentity(
  db: FastifyInstance["facilityDb"],
  input: {
    linked: { user: { id: string } } | undefined;
    invitedId: string;
    provider: string;
    subject: string;
    login: string | null;
    metadata: Record<string, unknown>;
    label: string;
  },
) {
  if (input.linked) {
    if (input.linked.user.id !== input.invitedId)
      throw new ApiError(
        403,
        "identity_conflict",
        `${input.label} identity is linked to another Facility user`,
      );
    return;
  }
  const conflicting = (
    await db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.userId, input.invitedId),
          eq(userIdentities.provider, input.provider),
        ),
      )
      .limit(1)
  )[0];
  if (conflicting)
    throw new ApiError(
      403,
      "identity_conflict",
      `This Facility user is linked to another ${input.label} identity`,
    );
  await db.insert(userIdentities).values({
    id: newId("user"),
    userId: input.invitedId,
    provider: input.provider,
    providerSubject: input.subject,
    login: input.login,
    metadata: input.metadata,
  });
}

async function ensureGithubUserTransaction(
  db: FastifyInstance["facilityDb"],
  identity: GithubExternalIdentity,
): Promise<{ userId: string; orgId: string }> {
  const { linked, invited } = await invitedUser(db, {
    provider: "github",
    subject: identity.githubUserId,
    verifiedEmails: identity.verifiedEmails,
    label: "GitHub",
  });

  const memberships = await db
    .select({ member: orgMembers, role: roles, installation: githubInstallations })
    .from(orgMembers)
    .innerJoin(roles, eq(orgMembers.roleId, roles.id))
    .innerJoin(githubInstallations, eq(githubInstallations.orgId, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, invited.id), isNull(githubInstallations.suspendedAt)))
    .orderBy(orgMembers.createdAt, orgMembers.orgId);
  const admitted = memberships.find(({ installation }) =>
    identity.installations.some(
      (candidate) =>
        candidate.installationId === installation.installationId &&
        candidate.accountId === installation.accountId,
    ),
  );
  if (!admitted)
    throw new ApiError(
      403,
      "installation_access_required",
      "GitHub App installation access is required for this Facility instance",
    );

  await linkIdentity(db, {
    linked,
    invitedId: invited.id,
    provider: "github",
    subject: identity.githubUserId,
    login: identity.login,
    metadata: { accountIds: identity.installations.map((entry) => entry.accountId) },
    label: "GitHub",
  });
  await db
    .update(users)
    .set({
      name: identity.name ?? invited.name,
      avatarUrl: identity.avatarUrl ?? invited.avatarUrl,
      updatedAt: new Date(),
    })
    .where(eq(users.id, invited.id));
  await db
    .update(userIdentities)
    .set({ login: identity.login, updatedAt: new Date() })
    .where(
      and(
        eq(userIdentities.provider, "github"),
        eq(userIdentities.providerSubject, identity.githubUserId),
      ),
    );
  return { userId: invited.id, orgId: admitted.member.orgId };
}

/**
 * An OIDC identity without GitHub claims proves no installation access, so it
 * is admitted only into local-mode organizations that still admit members.
 */
async function ensureOidcUserTransaction(
  db: FastifyInstance["facilityDb"],
  identity: OidcExternalIdentity,
): Promise<{ userId: string; orgId: string }> {
  // The issuer is part of the subject: `sub` is only unique within one issuer.
  const subject = `${identity.issuer}#${identity.subject}`;
  const { linked, invited } = await invitedUser(db, {
    provider: "oidc",
    subject,
    verifiedEmails: identity.verifiedEmails,
    label: "OIDC",
  });

  const admitted = (
    await db
      .select({ member: orgMembers })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(
        and(
          eq(orgMembers.userId, invited.id),
          eq(orgs.accessMode, "local"),
          orgAdmitsMembers(db, orgMembers.orgId),
        ),
      )
      .orderBy(orgMembers.createdAt, orgMembers.orgId)
      .limit(1)
  )[0];
  if (!admitted)
    throw new ApiError(
      403,
      "local_access_required",
      "Sign-in without GitHub admits only members of local-mode organizations",
    );

  await linkIdentity(db, {
    linked,
    invitedId: invited.id,
    provider: "oidc",
    subject,
    login: null,
    metadata: { issuer: identity.issuer },
    label: "OIDC",
  });
  await db
    .update(users)
    .set({
      name: identity.name ?? invited.name,
      avatarUrl: identity.avatarUrl ?? invited.avatarUrl,
      updatedAt: new Date(),
    })
    .where(eq(users.id, invited.id));
  return { userId: invited.id, orgId: admitted.member.orgId };
}

function cookieOptions(config: AppConfig, maxAge: number) {
  const callback =
    config.authCallbackUrl ?? `${config.webUrl ?? config.publicUrl}/api/auth/callback`;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: callback.startsWith("https://"),
    maxAge,
  };
}
