import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { isSafeGitBranch } from "../workspaces/git-branch.js";

/** Local repository access is disabled until an operator approves at least one root. */
export type LocalRepositoryOptions = {
  roots: string[];
  /** Owners allowed for registered paths; defaults to the Facility process owner. */
  ownerUids?: number[];
  maxSnapshotBytes?: number;
  maxFileBytes?: number;
};

export type LocalRepositoryInspection = {
  path: string;
  defaultBranch: string;
  headSha: string;
  /** Canonical Git common directory: one repository has one key, whichever worktree registered it. */
  repositoryKey: string;
  warnings: string[];
};

/** The name a local repository is registered under and referenced by as `local:<alias>`. */
export function isLocalAlias(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !/\.git$/i.test(value);
}

/** A registered repository: its canonical path and the Git common directory recorded with it. */
export type LocalSourceRefObject = { sourcePath: string; sourceRepository?: string | null };
export type LocalSourceRef = string | LocalSourceRefObject;

export type LocalTreeEntry = { mode: string; type: string; oid: string; path: string };

export class LocalRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "LocalRepositoryError";
  }
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
/** A full SHA-1 or SHA-256 object id. */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Read-only access to Git repositories on the machine running Facility.
 *
 * Every operation re-validates the stored canonical path against the approved
 * roots, so a path replaced by a symlink after registration is refused. Git runs
 * with system/global configuration ignored, hooks and fsmonitor disabled, and
 * replace objects ignored; Facility never writes to the source repository.
 */
export class LocalRepositoryHost {
  private readonly roots: string[];
  private readonly ownerUids: number[] | undefined;
  private readonly maxSnapshotBytes: number;
  private readonly maxFileBytes: number;

  constructor(options: LocalRepositoryOptions) {
    for (const root of options.roots) {
      if (!isAbsolute(root) || root.includes("\0")) {
        throw new LocalRepositoryError(
          "local_repository_root_invalid",
          "Local repository roots must be absolute paths",
          500,
        );
      }
    }
    this.roots = [...options.roots];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    this.ownerUids = options.ownerUids ?? (uid === undefined ? undefined : [uid]);
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  get enabled() {
    return this.roots.length > 0;
  }

  /** Validates a user-supplied path for registration. Nothing is executed from the repository. */
  async inspect(inputPath: string, requestedBranch?: string): Promise<LocalRepositoryInspection> {
    this.assertEnabled();
    const path = await this.canonical(inputPath);
    const repositoryKey = await this.assertRepositoryRoot(path);
    const defaultBranch = requestedBranch ?? (await this.currentBranch(path));
    const headSha = await this.resolveBranch(path, defaultBranch);
    return {
      path,
      defaultBranch,
      headSha,
      repositoryKey,
      warnings: await this.warnings(path, headSha),
    };
  }

  /**
   * Re-checks a registered path before any read. With the key recorded at
   * registration, a path that now belongs to a different repository is refused.
   */
  async verify(storedPath: string, repositoryKey?: string): Promise<string> {
    this.assertEnabled();
    const path = await this.canonical(storedPath);
    const key = path === storedPath ? await this.assertRepositoryRoot(path) : undefined;
    if (!key || (repositoryKey !== undefined && key !== repositoryKey)) {
      throw new LocalRepositoryError(
        "local_repository_path_changed",
        "The registered repository path now resolves to a different location; register it again",
        409,
      );
    }
    return path;
  }

  /** Verifies a registered repository given its stored path and, when recorded, its key. */
  private open(source: LocalSourceRef) {
    return typeof source === "string"
      ? this.verify(source)
      : this.verify(source.sourcePath, source.sourceRepository ?? undefined);
  }

  async resolve(source: LocalSourceRef, branch: string): Promise<string> {
    const path = await this.open(source);
    return this.resolveBranch(path, branch);
  }

  async readFile(
    source: LocalSourceRef,
    commit: string,
    file: string,
  ): Promise<string | undefined> {
    const path = await this.open(source);
    assertCommit(commit);
    const entry = (await this.tree(path, commit, [file])).find((item) => item.path === file);
    if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      return undefined;
    }
    return this.blob(path, entry.oid);
  }

  /** Lists regular files and symlinks under the given tree prefixes at a pinned commit. */
  async files(
    source: LocalSourceRef,
    commit: string,
    prefixes: string[],
    include: (path: string) => boolean = () => true,
  ) {
    const path = await this.open(source);
    assertCommit(commit);
    const entries = await this.tree(path, commit, prefixes);
    const files = new Map<string, string>();
    for (const entry of entries) {
      // Symlinks are returned as their target text, never followed on the host.
      if (entry.type !== "blob" || !include(entry.path)) continue;
      files.set(entry.path, await this.blob(path, entry.oid));
    }
    return files;
  }

  /** Paths of files at a pinned commit, without reading their content. */
  async paths(source: LocalSourceRef, commit: string, prefixes: string[] = []) {
    const path = await this.open(source);
    assertCommit(commit);
    return (await this.tree(path, commit, prefixes))
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
  }

  /**
   * Packages the complete history reachable from `commit` as a Git bundle whose
   * only ref is refs/facility/import. The copy happens in a Facility-owned
   * staging repository; the source repository is only read.
   */
  async snapshot(source: LocalSourceRef, commit: string): Promise<Buffer> {
    const path = await this.open(source);
    assertCommit(commit);
    const stage = await mkdtemp(join(tmpdir(), "facility-local-snapshot-"));
    try {
      const repository = join(stage, "repository.git");
      const bundle = join(stage, "snapshot.bundle");
      await this.git(stage, ["init", "--bare", "--quiet", "--template=", repository]);
      await this.git(repository, [
        "-c",
        `safe.directory=${path}`,
        // Only this Facility-initiated fetch of a validated path may use the file transport.
        "-c",
        "protocol.file.allow=always",
        "-c",
        "protocol.version=2",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        path,
        `${commit}:refs/facility/import`,
      ]);
      await this.git(repository, ["bundle", "create", "--quiet", bundle, "refs/facility/import"]);
      const size = (await stat(bundle)).size;
      if (size > this.maxSnapshotBytes) {
        throw new LocalRepositoryError(
          "local_repository_snapshot_too_large",
          `The repository snapshot is ${size} bytes, above the ${this.maxSnapshotBytes} byte limit`,
          413,
        );
      }
      return await readFile(bundle);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /**
   * Content the first import cannot represent faithfully yet. Both probes stay
   * bounded on very large repositories: neither lists the whole tree.
   */
  async warnings(source: LocalSourceRef, commit: string) {
    const path = await this.open(source);
    assertCommit(commit);
    const warnings: string[] = [];
    if ((await this.tree(path, commit, [".gitmodules"])).length > 0) {
      warnings.push(
        "Submodules are not imported. Their directories appear empty in Facility workspaces.",
      );
    }
    const lfs = await this.git(
      path,
      ["grep", "-l", "-e", "filter=lfs", commit, "--", ".gitattributes", "**/.gitattributes"],
      { okExitCodes: [1] },
    );
    if (lfs.trim()) {
      warnings.push(
        "Git LFS content is not imported. LFS files appear as pointer files in Facility workspaces.",
      );
    }
    return warnings;
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new LocalRepositoryError(
        "local_repositories_disabled",
        "Local repositories are disabled. Set FACILITY_LOCAL_REPOSITORY_ROOTS to the directories Facility may read.",
        403,
      );
    }
  }

  private async canonical(inputPath: string) {
    if (
      typeof inputPath !== "string" ||
      inputPath.length === 0 ||
      inputPath.length > 4_096 ||
      inputPath.includes("\0") ||
      !isAbsolute(inputPath) ||
      inputPath.split(/[\\/]/).includes("..")
    ) {
      throw new LocalRepositoryError(
        "local_repository_path_invalid",
        "Provide an absolute repository path without '..' segments",
      );
    }
    // Refuse before touching the filesystem, so the API never reveals whether a
    // path outside the approved roots exists.
    await this.assertInsideRoots(normalize(inputPath));
    let path: string;
    try {
      path = await realpath(inputPath);
    } catch {
      throw new LocalRepositoryError(
        "local_repository_not_found",
        "No directory exists at that path on the Facility host",
        404,
      );
    }
    await this.assertInsideRoots(path);
    await this.assertDirectory(path);
    return path;
  }

  /** A directory under an approved root, owned by a trusted user. */
  private async assertDirectory(path: string) {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new LocalRepositoryError(
        "local_repository_not_directory",
        "The repository path is not a directory",
      );
    }
    if (this.ownerUids && !this.ownerUids.includes(info.uid)) {
      throw new LocalRepositoryError(
        "local_repository_owner_untrusted",
        "The repository is owned by a user Facility is not configured to trust",
        403,
      );
    }
  }

  private async assertInsideRoots(path: string) {
    for (const root of this.roots) {
      const canonicalRoot = await realpath(root).catch(() => undefined);
      // A missing root approves nothing. A canonical path cannot pass through a
      // symlinked root, so matching the configured spelling only admits the
      // lexical pre-check that runs before realpath.
      if (canonicalRoot && (isInside(canonicalRoot, path) || isInside(root, path))) return;
    }
    throw new LocalRepositoryError(
      "local_repository_outside_roots",
      "The repository is outside the directories approved for Facility",
      403,
    );
  }

  /** Validates the repository at `path` and returns its canonical Git common directory. */
  private async assertRepositoryRoot(path: string) {
    let bare: boolean;
    try {
      bare = (await this.git(path, ["rev-parse", "--is-bare-repository"])).trim() === "true";
    } catch {
      throw new LocalRepositoryError(
        "local_repository_not_git",
        "The path is not a Git repository",
      );
    }
    const directories: string[] = [];
    // Worktrees and gitfiles may point elsewhere; the Git directories must be approved too.
    for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
      const value = (await this.git(path, ["rev-parse", flag])).trim();
      const directory = await realpath(isAbsolute(value) ? value : join(path, value)).catch(
        () => "",
      );
      if (!directory) {
        throw new LocalRepositoryError(
          "local_repository_not_git",
          "The Git directory is not available",
        );
      }
      await this.assertInsideRoots(directory);
      await this.assertDirectory(directory);
      directories.push(directory);
    }
    const [gitDir, commonDir] = directories as [string, string];
    // Git discovers a bare repository from any directory inside it, so a bare
    // repository is registered only at its own Git directory.
    const top = bare
      ? gitDir
      : await realpath((await this.git(path, ["rev-parse", "--show-toplevel"])).trim()).catch(
          () => "",
        );
    if (top !== path) {
      throw new LocalRepositoryError(
        "local_repository_not_root",
        "Register the repository's top-level directory",
      );
    }
    // Objects and refs reachable through links or alternates would bypass the roots.
    for (const entry of ["objects", "refs"]) {
      const target = await realpath(join(commonDir, entry)).catch(() => undefined);
      if (target) await this.assertInsideRoots(target);
    }
    const alternates = await readFile(
      join(commonDir, "objects", "info", "alternates"),
      "utf8",
    ).catch(() => "");
    if (alternates.trim()) {
      throw new LocalRepositoryError(
        "local_repository_alternates_unsupported",
        "The repository borrows objects from another repository (objects/info/alternates); run git repack -a -d and remove the alternates file first",
      );
    }
    return commonDir;
  }

  private async currentBranch(path: string) {
    try {
      return (await this.git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    } catch {
      throw new LocalRepositoryError(
        "local_repository_branch_required",
        "HEAD is detached; pass the branch Facility should use as the default branch",
      );
    }
  }

  private async resolveBranch(path: string, branch: string) {
    if (!isSafeGitBranch(branch)) {
      throw new LocalRepositoryError(
        "local_repository_branch_invalid",
        "The default branch name is not a valid Git branch",
      );
    }
    try {
      const sha = (
        await this.git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])
      ).trim();
      if (COMMIT_SHA.test(sha)) return sha;
    } catch {
      // Distinguish an empty repository from a missing branch below.
    }
    const heads = await this.git(path, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "refs/heads",
    ]).catch(() => "");
    if (!heads.trim()) {
      throw new LocalRepositoryError(
        "local_repository_empty",
        "The repository has no commits yet. Create an initial commit, then register it again.",
      );
    }
    throw new LocalRepositoryError(
      "local_repository_branch_not_found",
      `Branch ${branch} does not exist in the repository`,
    );
  }

  private async tree(path: string, commit: string, prefixes: string[]): Promise<LocalTreeEntry[]> {
    const output = await this.git(path, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      ...(prefixes.length ? ["--", ...prefixes] : []),
    ]);
    return output
      .split("\0")
      .filter(Boolean)
      .flatMap((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, oid] = line.slice(0, tab).split(" ");
        const entryPath = line.slice(tab + 1);
        return tab > 0 && mode && type && oid ? [{ mode, type, oid, path: entryPath }] : [];
      });
  }

  private async blob(path: string, oid: string) {
    const size = Number((await this.git(path, ["cat-file", "-s", oid])).trim());
    if (!Number.isFinite(size) || size > this.maxFileBytes) {
      throw new LocalRepositoryError(
        "local_repository_file_too_large",
        `A configuration file is larger than ${this.maxFileBytes} bytes`,
        413,
      );
    }
    return this.git(path, ["cat-file", "blob", oid]);
  }

  private git(cwd: string, args: string[], options: { okExitCodes?: number[] } = {}) {
    return new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          `safe.directory=${cwd}`,
          ...args,
        ],
        {
          cwd,
          env: hardenedGitEnvironment(),
          encoding: "utf8",
          maxBuffer: this.maxFileBytes * 4 + 64 * 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
        },
        (error, stdout, stderr) => {
          if (error && !options.okExitCodes?.includes(error.code as number)) {
            reject(
              new LocalRepositoryError(
                "local_repository_git_failed",
                stderr.trim().split("\n").at(-1) || `git ${args[0]} failed`,
                409,
              ),
            );
          } else resolve(stdout);
        },
      );
    });
  }
}

/** Parses FACILITY_LOCAL_REPOSITORY_ROOTS: absolute POSIX paths separated by ':'. */
export function parseLocalRepositoryRoots(value: string | undefined) {
  return (value ?? "")
    .split(":")
    .map((root) => root.trim())
    .filter(Boolean);
}

export function isInside(root: string, path: string) {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function assertCommit(commit: string) {
  if (!COMMIT_SHA.test(commit)) {
    throw new LocalRepositoryError("local_repository_revision_invalid", "Invalid commit id");
  }
}

/** A private, empty HOME: git must not read user configuration from a shared /tmp. */
const gitHome = mkdtempSync(join(tmpdir(), "facility-git-home-"));

function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: gitHome,
    XDG_CONFIG_HOME: gitHome,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
  };
}
