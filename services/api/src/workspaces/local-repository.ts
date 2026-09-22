import { isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const LocalPath = z.string().trim().min(1).refine(isAbsolute, "local repository path must be absolute");
const LocalRemote = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isAbsolute(value) || value.startsWith("file://"), "local repository remote must be an absolute path or file:// URL");

export const LocalRepositorySourceSchema = z
  .object({
    type: z.literal("local"),
    path: LocalPath.optional(),
    remote: LocalRemote.optional(),
    owner: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i).default("local"),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i),
    defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).default("main"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.path === undefined) === (value.remote === undefined)) {
      context.addIssue({ code: "custom", message: "local repository source requires exactly one of path or remote" });
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
  return validated.path ?? validated.remote!;
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
