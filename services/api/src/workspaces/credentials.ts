import type { GithubGitIdentity } from "../github/git-identity.js";

/** Where a project's repositories come from. A project never mixes sources. */
export type RepositorySource = "github" | "local";

export type WorkspaceRepository = {
  /** Project repository id. */
  id: string;
  source: RepositorySource;
  owner: string;
  name: string;
  defaultBranch: string;
  role: "primary" | "related";
};

/** Repository access for one workspace preparation; local sources carry no credentials. */
export type WorkspaceCredentials = {
  /** The project's repository source; every repository shares it. */
  source: RepositorySource;
  repositories: WorkspaceRepository[];
  environment: Record<string, string>;
  expiresAt: Date;
  gitIdentity: GithubGitIdentity;
};
