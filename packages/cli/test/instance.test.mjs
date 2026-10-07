import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { bootstrapInstance } from "../src/instance.mjs";

const valid = {
  "org-name": "Facility Test",
  "org-slug": "facility-test",
  "owner-email": "owner@example.com",
  "owner-name": "Owner",
  "github-user-id": "123",
  "github-login": "owner",
  "github-account-id": "456",
  "github-installation-id": "789",
  "github-account-login": "facility-test",
  json: true,
};

const local = {
  local: true,
  "org-name": "Facility Local Test",
  "org-slug": "facility-local-test",
  "owner-email": "Owner@Example.com",
  "owner-name": "Owner",
  json: true,
};

test("bootstrap validates all identity and installation bindings before connecting", async () => {
  assert.equal(await bootstrapInstance({ ...valid, "github-user-id": "not-a-number" }, { databaseUrl: "postgres://unused" }), 1);
});

test("local bootstrap refuses GitHub bindings and malformed input before connecting", async () => {
  const unused = { databaseUrl: "postgres://unused" };
  assert.equal(await bootstrapInstance({ ...local, "github-installation-id": "789" }, unused), 1);
  assert.equal(await bootstrapInstance({ ...local, "owner-email": "not-an-email" }, unused), 1);
  assert.equal(await bootstrapInstance({ ...local, "org-slug": "Not A Slug" }, unused), 1);
  assert.equal(await bootstrapInstance({ ...local, "owner-name": undefined }, unused), 1);
});

/** A throwaway schema holding just the tables bootstrap touches. */
async function withBootstrapSchema(t, run) {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
  const admin = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try { await admin`select 1`; } catch { await admin.end(); t.skip("Postgres unreachable"); return; }
  const schema = `cli_bootstrap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await admin.unsafe(`
      CREATE TABLE "${schema}".roles (id text primary key, org_id text, name text);
      CREATE TABLE "${schema}".orgs (id text primary key, name text, slug text unique, settings jsonb, access_mode text not null default 'github');
      CREATE TABLE "${schema}".users (id text primary key, email text unique, name text, status text);
      CREATE TABLE "${schema}".user_identities (id text primary key, user_id text, provider text, provider_subject text, login text, metadata jsonb);
      CREATE TABLE "${schema}".org_members (id text primary key, org_id text, user_id text, role_id text);
      CREATE TABLE "${schema}".github_installations (id text primary key, org_id text, installation_id bigint, account_id bigint, account_login text, target_type text);
      INSERT INTO "${schema}".roles (id, org_id, name) VALUES ('role_bundled_owner', null, 'owner');
    `);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    await run({ admin, schema, databaseUrl: scoped.toString() });
  } finally {
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

test("bootstrap is transactional, idempotent for identical input, and rejects conflicts", async (t) => {
  await withBootstrapSchema(t, async ({ admin, schema, databaseUrl }) => {
    assert.equal(await bootstrapInstance(valid, { databaseUrl }), 0);
    assert.equal(await bootstrapInstance(valid, { databaseUrl }), 0);
    assert.equal(await bootstrapInstance({ ...valid, "github-user-id": "124" }, { databaseUrl }), 1);
    assert.equal(await bootstrapInstance({ ...valid, "owner-name": "Different owner" }, { databaseUrl }), 1);
    // A GitHub instance never becomes a local-mode one.
    assert.equal(await bootstrapInstance(local, { databaseUrl }), 1);
    const rows = await admin.unsafe(`SELECT count(*)::int AS count, min(access_mode) AS mode FROM "${schema}".orgs`);
    assert.deepEqual({ ...rows[0] }, { count: 1, mode: "github" });
  });
});

test("local bootstrap creates a local-mode owner without GitHub and stays idempotent", async (t) => {
  await withBootstrapSchema(t, async ({ admin, schema, databaseUrl }) => {
    assert.equal(await bootstrapInstance(local, { databaseUrl }), 0);
    const [org] = await admin.unsafe(`SELECT id, slug, access_mode FROM "${schema}".orgs`);
    assert.deepEqual({ slug: org.slug, access_mode: org.access_mode }, { slug: "facility-local-test", access_mode: "local" });
    const [owner] = await admin.unsafe(`SELECT u.email, m.role_id FROM "${schema}".users u JOIN "${schema}".org_members m ON m.user_id = u.id`);
    assert.deepEqual({ ...owner }, { email: "owner@example.com", role_id: "role_bundled_owner" });
    const [bindings] = await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM "${schema}".github_installations) AS installations,
      (SELECT count(*)::int FROM "${schema}".user_identities) AS identities`);
    assert.deepEqual({ ...bindings }, { installations: 0, identities: 0 });

    assert.equal(await bootstrapInstance(local, { databaseUrl }), 0);
    // The owner's first sign-in links an identity; bootstrap stays idempotent afterwards.
    await admin.unsafe(`INSERT INTO "${schema}".user_identities (id, user_id, provider, provider_subject)
      SELECT 'identity_1', id, 'oidc', 'https://idp.test#owner' FROM "${schema}".users`);
    assert.equal(await bootstrapInstance(local, { databaseUrl }), 0);

    assert.equal(await bootstrapInstance({ ...local, "owner-email": "other@example.com" }, { databaseUrl }), 1);
    assert.equal(await bootstrapInstance({ ...local, "org-slug": "another-org" }, { databaseUrl }), 1);
    // A local-mode instance never gains a GitHub installation through bootstrap.
    assert.equal(await bootstrapInstance(valid, { databaseUrl }), 1);
    const [counts] = await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM "${schema}".orgs) AS orgs,
      (SELECT count(*)::int FROM "${schema}".github_installations) AS installations`);
    assert.deepEqual({ ...counts }, { orgs: 1, installations: 0 });
  });
});
