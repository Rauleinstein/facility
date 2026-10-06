import { renderWorkspaceKickstart } from "@facility/core";
import { detectWorkspace, inferStartCommand, type KickstartAnswers } from "../github/kickstart.js";
import {
  DEFAULT_LOCAL_GIT_IDENTITY,
  LocalRepositoryError,
  type LocalRepositoryHost,
  type LocalSourceRefObject,
} from "./local.js";

/** The branch kickstart creates, mirroring the GitHub kickstart PR branch. */
export const LOCAL_KICKSTART_BRANCH = "facility/kickstart";
const LOCAL_KICKSTART_MESSAGE = "feat: configure Facility local workflow";

const DETECTION_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".facility.yml",
];

/**
 * Starter configuration for a local repository, previewed without writing
 * anything. `createLocalKickstartBranch` commits the same files to a new
 * branch, the local counterpart of the GitHub kickstart PR; the patch remains
 * for repositories Facility may not write to.
 */
export async function localKickstart(
  host: LocalRepositoryHost,
  repository: { name: string; defaultBranch: string } & LocalSourceRefObject,
  answers: KickstartAnswers,
) {
  const baseSha = await host.resolve(repository, repository.defaultBranch);
  const paths = await host.paths(repository, baseSha, [...DETECTION_FILES, ".agents"]);
  const existing = new Map<string, string>();
  for (const path of paths) {
    if (path === "package.json") {
      existing.set(path, (await host.readFile(repository, baseSha, path)) ?? "");
    } else if (DETECTION_FILES.includes(path) || /^\.agents\/[^/]+\.md$/.test(path)) {
      // Only presence matters for these files; their content is never read.
      existing.set(path, "");
    }
  }
  const detection = detectWorkspace(existing, repository.defaultBranch);
  const rendered = renderWorkspaceKickstart(
    {
      repository: repository.name,
      source: "local",
      setup: answers.provisionCmd?.trim() || detection.setup,
      start: answers.startCmd?.trim() || inferStartCommand(existing, detection.packageManager),
      ready: answers.readyCmd?.trim() || undefined,
      servicePort: answers.servicePort ?? 3000,
      models: answers.models,
    },
    existing,
  );
  return {
    baseSha,
    detection,
    files: rendered.files,
    skipped: rendered.skipped,
    manifest: rendered.manifest,
    branch: LOCAL_KICKSTART_BRANCH,
    patch: newFilesPatch(rendered.files),
    instructions: [
      "git apply --check facility-kickstart.patch",
      "git apply facility-kickstart.patch",
      "git add .facility.yml .agents",
      `git commit -m "${LOCAL_KICKSTART_MESSAGE}"`,
    ],
  };
}

/**
 * Commits the starter files to `facility/kickstart` on top of the default
 * branch. Refuses when the branch exists, so a repeat never overwrites it.
 */
export async function createLocalKickstartBranch(
  host: LocalRepositoryHost,
  repository: { name: string; defaultBranch: string } & LocalSourceRefObject,
  answers: KickstartAnswers,
  author: { name: string; email: string } = DEFAULT_LOCAL_GIT_IDENTITY,
) {
  const preview = await localKickstart(host, repository, answers);
  if (preview.files.length === 0) {
    throw new LocalRepositoryError(
      "local_kickstart_complete",
      "The repository already has .facility.yml and its agents",
      409,
    );
  }
  const { commitSha } = await host.createBranch(repository, preview.baseSha, {
    branch: LOCAL_KICKSTART_BRANCH,
    message: LOCAL_KICKSTART_MESSAGE,
    author,
    files: preview.files,
  });
  return {
    branch: LOCAL_KICKSTART_BRANCH,
    baseSha: preview.baseSha,
    commitSha,
    files: preview.files.map((file) => file.path),
    instructions: [
      `git log --stat ${repository.defaultBranch}..${LOCAL_KICKSTART_BRANCH}`,
      `git merge ${LOCAL_KICKSTART_BRANCH}`,
    ],
  };
}

/** A `git apply` compatible patch that only creates files. */
export function newFilesPatch(files: Array<{ path: string; content: string }>) {
  if (files.length === 0) return "";
  return files
    .map((file) => {
      const trailingNewline = file.content.endsWith("\n");
      const lines = file.content.split("\n");
      if (trailingNewline) lines.pop();
      return [
        `diff --git a/${file.path} b/${file.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        ...(trailingNewline ? [] : ["\\ No newline at end of file"]),
      ].join("\n");
    })
    .join("\n")
    .concat("\n");
}
