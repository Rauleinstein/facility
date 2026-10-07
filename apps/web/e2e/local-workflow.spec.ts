import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// The local workflow as a person runs it in the browser: register a repository,
// create the kickstart branch, start a story, review, check, approve, export and
// import. The agent is the scripted engine, so every run is identical.

const root = process.env.FACILITY_E2E_REPOSITORY_ROOT ?? "";
const alias = `e2e-${Date.now().toString(36)}`;
const repository = join(root, alias);

function git(...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=Facility E2E", "-c", "user.email=e2e@localhost", ...args],
    { cwd: repository, encoding: "utf8" },
  );
}

function commitManifest(message: string, edit: (manifest: string) => string) {
  const path = join(repository, ".facility.yml");
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  git("commit", "-qam", message);
}

test.beforeAll(() => {
  mkdirSync(repository, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify({ name: alias, private: true, scripts: { dev: "true", test: "node --test" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(repository, "smoke.test.js"),
    'import { test } from "node:test";\ntest("smoke", () => {});\n',
  );
  git("add", "-A");
  git("commit", "-qm", "chore: initial commit");
});

// Each story gets a workspace with its own Docker network, and Docker's address
// pools run out after a few dozen, so every run deletes the workspace it made.
let storyUrl: string | undefined;
test.afterEach(async ({ page }) => {
  if (storyUrl) await deleteWorkspace(page, storyUrl);
});

async function deleteWorkspace(page: Page, url: string) {
  const [, projectId, storyId] = /\/projects\/([^/]+)\/stories\/([^/?#]+)/.exec(url) ?? [];
  const response = await page.request.delete(
    `/api/v1/projects/${projectId}/workspace-stories/${storyId}/workspace`,
    {
      data: { confirm: true, idempotency_key: `e2e-delete-${storyId}` },
      headers: { "idempotency-key": `e2e-delete-${storyId}` },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

test("a local story goes from registration to an imported export", async ({ page }) => {
  await test.step("sign in locally", async () => {
    await page.goto("/login");
    await page.getByRole("link", { name: "continue locally" }).click();
    await expect(page).toHaveURL(/\/projects/);
  });

  await test.step("register the repository and create the kickstart branch", async () => {
    await page.goto("/projects/new");
    await page.getByRole("button", { name: "on this machine" }).click();
    await page.getByLabel("Project name").fill(alias);
    await page.getByLabel("Repository path on the Facility host").fill(repository);
    await page.getByRole("button", { name: "Register repository" }).click();
    await expect(page.getByText(`Registered local:${alias}`)).toBeVisible();
    await page.getByRole("button", { name: "Create branch facility/kickstart" }).click();
    await expect(page.getByText("Created branch")).toBeVisible();
  });

  await test.step("merge the kickstart with a broken manifest and checks", async () => {
    git("merge", "-q", "--ff-only", "facility/kickstart");
    // No `start`: starting a story must fail, and the retry below must not replay it.
    commitManifest("chore: configure checks", (manifest) =>
      manifest
        .replace(/^ {2}start: .*\n/m, "")
        .replace(/^environment:\n/m, "environment:\n  checks:\n    test: npm test\n"),
    );
  });

  await test.step("a rejected start can be retried once the cause is fixed", async () => {
    await page.getByRole("link", { name: "Open the project" }).click();
    await page.getByRole("link", { name: "Stories", exact: true }).click();
    await page
      .getByPlaceholder(/Describe what you need/)
      .fill("Append a scripted change\n\nThe scripted engine commits facility-e2e.txt.");
    await page.getByRole("button", { name: "Start story" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "environment.start" })).toBeVisible();

    commitManifest("chore: restore the start command", (manifest) =>
      manifest.replace(/^environment:\n/m, 'environment:\n  start: "true"\n'),
    );
    await page.getByRole("button", { name: "Start story" }).click();
    await expect(page).toHaveURL(/\/stories\/story_/);
    storyUrl = page.url();
  });

  await test.step("the agent turn completes with a commit", async () => {
    const completed = page.getByText("Scripted change committed to facility-e2e.txt.");
    // Stop waiting as soon as the turn fails, then report which outcome it was.
    await expect(completed.or(page.getByText("builder failed"))).toBeVisible({
      timeout: 5 * 60_000,
    });
    await expect(completed).toBeVisible();
  });

  await test.step("review, check, approve and export", async () => {
    await page.reload();
    await page.locator("summary", { hasText: "Review and export" }).click();
    await expect(page.getByText("feat: scripted change")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Run checks" }).click();
    await expect(page.getByText("passed")).toBeVisible({ timeout: 2 * 60_000 });
    await page.getByLabel("Review note").fill("Scripted change verified by the e2e test.");
    await page.getByRole("button", { name: /^Approve / }).click();
    await expect(page.getByText(/^Approved/)).toBeVisible();
    await page.getByRole("button", { name: "Export approved commits" }).click();
    await expect(page.getByRole("link", { name: "Download bundle" })).toBeVisible();
  });

  await test.step("the exported bundle imports into the repository", async () => {
    const href = await page.getByRole("link", { name: "Download bundle" }).getAttribute("href");
    const response = await page.request.get(href ?? "");
    expect(response.ok()).toBe(true);
    const bundle = join(root, `${alias}.bundle`);
    writeFileSync(bundle, await response.body());
    const [head] = git("bundle", "list-heads", bundle).trim().split("\n");
    const ref = head?.split(" ")[1] ?? "";
    git("fetch", "-q", bundle, `${ref}:refs/heads/facility-review/e2e`);
    expect(git("log", "--format=%s", "main..facility-review/e2e").trim()).toBe(
      "feat: scripted change",
    );
    expect(git("show", "facility-review/e2e:facility-e2e.txt")).toMatch(/^turn_/);
  });
});
