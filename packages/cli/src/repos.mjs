// `facility repos add-local` registers a Git repository on the machine running
// Facility. Only committed history is ever imported; the command says so, and
// lists what stays behind, before it registers anything.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { banner, bold, dim, heading, item, ok, warn } from "./ui.mjs";

export async function addLocalRepository(flags, positional, version, fetchImpl = fetch) {
  const path = resolve(positional[0] ?? process.cwd());
  const apiUrl = String(flags.api || process.env.FACILITY_API_URL || "http://localhost:4400").replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.FACILITY_API_KEY;
  const projectId = flags.project || process.env.FACILITY_PROJECT_ID;
  const fail = (code, message) => {
    if (flags.json) console.log(JSON.stringify({ error: { code, message } }));
    else console.error(message);
    return 1;
  };
  if (!apiKey) return fail("api_key_required", "Set FACILITY_API_KEY to an API key with repos:write.");
  if (!projectId) return fail("project_required", "Pass --project=<id> or set FACILITY_PROJECT_ID.");

  const left = leftBehind(path, flags.branch);
  if (!flags.json) {
    banner(version);
    heading("Import contract");
    item("Facility imports committed history from the default branch only.");
    if (left.error) warn(`Could not list what stays behind: ${left.error}`);
    if (left.paths.length) {
      warn(`${left.paths.length} uncommitted or untracked path${left.paths.length === 1 ? "" : "s"} will not be imported:`);
      for (const entry of left.paths.slice(0, 10)) item(dim(`  ${entry}`));
      if (left.paths.length > 10) item(dim(`  … and ${left.paths.length - 10} more`));
    }
    if (left.unmergedCommits) {
      warn(`${left.unmergedCommits} commit${left.unmergedCommits === 1 ? "" : "s"} on the checked-out branch ${left.unmergedCommits === 1 ? "is" : "are"} not on ${flags.branch} and will not be imported.`);
    }
  }
  const body = {
    path,
    ...(flags.alias ? { alias: flags.alias } : {}),
    ...(flags.branch ? { defaultBranch: flags.branch } : {}),
  };

  const response = await fetchImpl(`${apiUrl}/v1/projects/${encodeURIComponent(projectId)}/repos/local`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      // Per run: the API replays stored 4xx answers, so a retry after fixing the repository must not reuse a key.
      "idempotency-key": `cli-add-local-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return fail(
      payload?.error?.code ?? `http_${response.status}`,
      payload?.error?.message ?? `Facility API request failed (${response.status})`,
    );
  }
  if (flags.json) {
    console.log(JSON.stringify({ ...payload, leftBehind: left }));
    return 0;
  }
  heading("Registered");
  ok(`${bold(payload.manifestName)} → ${payload.sourcePath}`);
  item(`default branch   ${bold(payload.defaultBranch)} at ${payload.headSha?.slice(0, 12)}`);
  item(`role             ${payload.role}`);
  for (const warning of payload.warnings ?? []) warn(warning);
  item(dim(`Use repositories.${payload.role === "primary" ? "primary" : "related"}: ${payload.manifestName} in .facility.yml.`));
  return 0;
}

/** What the import leaves behind: uncommitted paths, and commits off the chosen branch. */
function leftBehind(path, branch) {
  const git = (args) =>
    spawnSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) {
    return { paths: [], unmergedCommits: 0, error: status.stderr.trim() || "git status failed" };
  }
  const paths = status.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const ahead = branch ? git(["rev-list", "--count", `refs/heads/${branch}..HEAD`, "--"]) : null;
  const unmergedCommits = ahead?.status === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
  return { paths, unmergedCommits, error: null };
}
