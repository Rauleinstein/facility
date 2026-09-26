import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  migrate,
  orgMembers,
  orgs,
  seed,
  userIdentities,
  users,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

describe("OIDC sign-in without GitHub for local-mode organizations", async () => {
  const probe = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  let reachable = true;
  try {
    await probe`select 1`;
  } catch {
    reachable = false;
  } finally {
    await probe.end();
  }
  if (!reachable) {
    it.skip("Postgres unreachable", () => undefined);
    return;
  }

  const issuer = "https://idp.local.test";
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: "idp", alg: "ES256" };
  // What the fake identity provider signs next; the nonce comes from the login redirect.
  let next: { subject: string; email: string; claims?: Record<string, unknown> } = {
    subject: "",
    email: "",
  };
  let nonce = "";
  let githubCalls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith(issuer)) {
      githubCalls += 1;
      return json({}, 404);
    }
    if (url.endsWith("/.well-known/openid-configuration"))
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.endsWith("/jwks")) return json({ keys: [publicJwk] });
    if (url.endsWith("/token"))
      return json({
        id_token: await new SignJWT({
          nonce,
          email: next.email,
          email_verified: true,
          ...next.claims,
        })
          .setProtectedHeader({ alg: "ES256", kid: "idp" })
          .setIssuer(issuer)
          .setAudience("facility-local-client")
          .setSubject(next.subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey),
      });
    return json({}, 404);
  };
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 31).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:dev",
    workspaceDriver: "docker",
    facilityInsecureDev: false,
    logLevel: "silent",
    authIdentityProvider: "oidc",
    authCallbackUrl: "http://localhost:3400/api/auth/callback",
    oidcIssuer: issuer,
    oidcClientId: "facility-local-client",
    facilityInstanceId: "instance_local",
  };
  const app = await buildApp(config, { authFetch: fakeFetch });
  const { db, client } = createDb(databaseUrl);
  const run = Date.now().toString(36);

  async function member(input: {
    accessMode: "github" | "local";
    installation?: "active" | "suspended";
    email?: string;
    userId?: string;
    status?: string;
  }) {
    const orgId = newId("org");
    const userId = input.userId ?? newId("user");
    const email = input.email ?? `${userId}@example.com`;
    await db.insert(orgs).values({
      id: orgId,
      name: `OIDC ${orgId}`,
      slug: `oidc-${orgId.slice(-12).toLowerCase()}`,
      accessMode: input.accessMode,
    });
    if (!input.userId)
      await db.insert(users).values({ id: userId, email, status: input.status ?? "active" });
    await db
      .insert(orgMembers)
      .values({ id: newId("member"), orgId, userId, roleId: "role_bundled_owner" });
    if (input.installation)
      await db.insert(githubInstallations).values({
        id: newId("int"),
        orgId,
        installationId: 7_500_000 + Math.floor(Math.random() * 1_000_000),
        accountId: 7_600_000,
        accountLogin: "oidc-test",
        targetType: "Organization",
        suspendedAt: input.installation === "suspended" ? new Date() : null,
      });
    return { orgId, userId, email };
  }

  async function signIn(subject: string, email: string, claims?: Record<string, unknown>) {
    const start = await app.inject({ method: "GET", url: "/auth/login" });
    expect(start.statusCode).toBe(302);
    const authorization = new URL(String(start.headers.location));
    expect(authorization.origin).toBe(issuer);
    nonce = String(authorization.searchParams.get("nonce"));
    next = { subject, email, claims };
    const state = start.cookies.find((cookie) => cookie.name === "facility_oauth_state");
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=code&state=${authorization.searchParams.get("state")}`,
      headers: { cookie: `${state?.name}=${state?.value}` },
    });
    const session = callback.cookies.find((cookie) => cookie.name === "facility_session");
    return { callback, session };
  }

  async function me(session: { name: string; value: string } | undefined) {
    return app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${session?.name}=${session?.value}` },
    });
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("admits an invited member of a local-mode organization with no GitHub call", async () => {
    const account = await member({ accessMode: "local", email: `Local-${run}@Example.com` });
    const { callback, session } = await signIn(`owner-${run}`, `local-${run}@example.com`);
    expect(callback.statusCode, callback.body).toBe(302);
    const response = await me(session);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().principal).toMatchObject({
      userId: account.userId,
      orgId: account.orgId,
    });
    const [identity] = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, account.userId));
    expect(identity).toMatchObject({
      provider: "oidc",
      providerSubject: `${issuer}#owner-${run}`,
      login: null,
    });
    expect(githubCalls).toBe(0);

    // A linked subject keeps signing in after the identity provider's email changes.
    const again = await signIn(`owner-${run}`, `renamed-${run}@example.com`);
    expect(again.callback.statusCode, again.callback.body).toBe(302);
    expect((await me(again.session)).json().principal.userId).toBe(account.userId);
  });

  it("signs a member of both kinds of organization into the local-mode one", async () => {
    const github = await member({ accessMode: "github", installation: "active" });
    const local = await member({ accessMode: "local", userId: github.userId });
    const { session } = await signIn(`both-${run}`, github.email);
    const response = await me(session);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().principal.orgId).toBe(local.orgId);
  });

  it.each([
    [
      "a member of a GitHub organization only",
      { accessMode: "github", installation: "active" },
      "local_access_required",
    ],
    [
      "a local-mode organization with a suspended installation",
      { accessMode: "local", installation: "suspended" },
      "local_access_required",
    ],
    ["a deactivated member", { accessMode: "local", status: "disabled" }, "not_invited"],
  ] as const)("refuses %s", async (label, setup, code) => {
    const account = await member(setup);
    const { callback, session } = await signIn(`refused-${label.length}-${run}`, account.email);
    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe(code);
    expect(session).toBeUndefined();
    const linked = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, account.userId));
    expect(linked).toEqual([]);
  });

  it("refuses a verified email with no invitation", async () => {
    const { callback, session } = await signIn(`stranger-${run}`, `stranger-${run}@example.com`);
    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe("not_invited");
    expect(session).toBeUndefined();
  });

  it("refuses a second subject for a user already linked to another", async () => {
    const account = await member({ accessMode: "local" });
    expect((await signIn(`first-${run}`, account.email)).callback.statusCode).toBe(302);
    const { callback, session } = await signIn(`second-${run}`, account.email);
    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe("identity_conflict");
    expect(session).toBeUndefined();
  });

  it("refuses a token bound to another Facility instance", async () => {
    const account = await member({ accessMode: "local" });
    const { callback } = await signIn(`other-instance-${run}`, account.email, {
      facility_instance_id: "another_instance",
    });
    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe("identity_mismatch");
  });

  it("rejects a forged callback state before contacting the identity provider", async () => {
    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=code&state=forged",
    });
    expect(callback.statusCode).toBe(401);
    expect(callback.json().error.code).toBe("bad_state");
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
