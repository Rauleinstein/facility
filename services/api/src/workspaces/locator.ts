import type { WorkspaceLocator } from "./runtime.js";

type WorkspaceRow = {
  id: string;
  externalRef: string | null;
  volumeRef: WorkspaceLocator["volumeRef"];
  environment: unknown;
};

/**
 * The runtime locator recorded on a workspace row, or undefined while the
 * workspace has no compute reference or image yet. Callers decide which error
 * a not-ready workspace is in their context.
 */
export function readWorkspaceLocator(row: WorkspaceRow): WorkspaceLocator | undefined {
  const environment = row.environment as {
    image?: unknown;
    variables?: unknown;
    ports?: WorkspaceLocator["ports"];
    resources?: WorkspaceLocator["resources"];
  };
  if (!row.externalRef || typeof environment.image !== "string" || !environment.image) {
    return undefined;
  }
  return {
    id: row.id,
    image: environment.image,
    environment:
      environment.variables && typeof environment.variables === "object"
        ? (environment.variables as Record<string, string>)
        : {},
    ports: Array.isArray(environment.ports) ? environment.ports : [],
    resources: environment.resources,
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
  };
}
