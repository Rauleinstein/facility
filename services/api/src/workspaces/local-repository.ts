import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const LocalPath = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "local repository path must be absolute");
const LocalRemote = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => isAbsolute(value) || value.startsWith("file://"),
    "local repository remote must be an absolute path or file:// URL",
  );

export const LocalRepositorySourceSchema = z
  .object({
    type: z.literal("local"),
    path: LocalPath.optional(),
    remote: LocalRemote.optional(),
    owner: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i)
      .default("local"),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i),
    defaultBranch: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,200}$/)
      .default("main"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.path === undefined) === (value.remote === undefined)) {
      context.addIssue({
        code: "custom",
        message: "local repository source requires exactly one of path or remote",
      });
    }
  });

export type LocalRepositorySource = z.infer<typeof LocalRepositorySourceSchema>;

export function repositorySourceFromSettings(settings: unknown): LocalRepositorySource {
  if (!settings || typeof settings !== "object" || !("repositorySource" in settings)) {
    throw new Error("project settings.repositorySource must explicitly configure local mode");
  }
  const source = (settings as { repositorySource?: unknown }).repositorySource;
  if (!source || typeof source !== "object" || (source as { type?: unknown }).type !== "local") {
    throw new Error("project settings.repositorySource must use the local source discriminator");
  }
  return LocalRepositorySourceSchema.parse(source);
}

export function repositoryCloneSource(source: LocalRepositorySource): string {
  const validated = LocalRepositorySourceSchema.parse(source);
  if (validated.path) return validated.path;
  const remote = validated.remote;
  if (!remote) throw new Error("local repository source has no remote");
  return remote.startsWith("file://") ? fileURLToPath(remote) : remote;
}

export function assertLocalRepositorySourceWithinRoot(
  source: LocalRepositorySource,
  root: string,
): void {
  const candidatePath = resolve(source.path ?? repositoryCloneSource(source));
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, candidatePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${"\\"}`) ||
    relativePath.startsWith("../")
  ) {
    throw new Error("local repository source must be under the configured local repository root");
  }
}

export async function assertLocalRepositorySourceWithinRootRealpath(
  source: LocalRepositorySource,
  root: string,
): Promise<void> {
  const [rootPath, candidatePath] = await Promise.all([
    realpath(root),
    realpath(source.path ?? repositoryCloneSource(source)),
  ]);
  assertLocalRepositorySourceWithinRoot(
    { ...source, path: candidatePath, remote: undefined },
    rootPath,
  );
}

export function repositoryMountTarget(source: LocalRepositorySource): string {
  const validated = LocalRepositorySourceSchema.parse(source);
  return `/facility-local-repositories/${validated.owner}/${validated.name}`;
}

export async function readLocalManifest(source: LocalRepositorySource): Promise<string> {
  const validated = LocalRepositorySourceSchema.parse(source);
  if (validated.path) return readFile(`${validated.path}/.facility.yml`, "utf8");
  const gitDir = validated.remote?.startsWith("file://")
    ? fileURLToPath(validated.remote)
    : repositoryCloneSource(validated);
  const { stdout } = await execFileAsync("git", [
    `--git-dir=${gitDir}`,
    "show",
    `${validated.defaultBranch}:.facility.yml`,
  ]);
  return stdout;
}
