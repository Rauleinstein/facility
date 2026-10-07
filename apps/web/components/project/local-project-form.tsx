"use client";

import { Button, Field, TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  LocalKickstart,
  LocalKickstartBranch,
  LocalRepositoryRegistration,
  LocalRepositoryStatus,
  Project,
} from "@/lib/api";
import { clientApi } from "@/lib/client-api";

/**
 * A project backed by a Git repository on the machine running Facility. No
 * GitHub App, installation, or hosted remote is involved: Facility imports the
 * committed history into its own workspaces. Starter configuration is
 * previewed first; on request Facility commits it to a new branch the user
 * merges, with a patch as fallback.
 */
export function LocalProjectForm() {
  const router = useRouter();
  const [status, setStatus] = useState<LocalRepositoryStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [alias, setAlias] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [repository, setRepository] = useState<LocalRepositoryRegistration | null>(null);
  const [kickstart, setKickstart] = useState<LocalKickstart | null>(null);
  const [created, setCreated] = useState<LocalKickstartBranch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void clientApi<LocalRepositoryStatus>("GET", "/v1/local-repositories/status").then((result) => {
      if (result.ok) setStatus(result.data);
      else setStatusError(result.message);
    });
  }, []);

  const slug = useMemo(
    () =>
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60),
    [name],
  );

  async function register() {
    setBusy(true);
    setError("");
    const created =
      project ??
      (await clientApi<Project>("POST", "/v1/projects", {
        name: name.trim(),
        slug,
      }).then((result) => {
        if (!result.ok) {
          setError(result.message);
          return null;
        }
        setProject(result.data);
        return result.data;
      }));
    if (!created) {
      setBusy(false);
      return;
    }
    const registered = await clientApi<LocalRepositoryRegistration>(
      "POST",
      `/v1/projects/${encodeURIComponent(created.id)}/repos/local`,
      { path: path.trim(), ...(alias.trim() ? { alias: alias.trim() } : {}) },
    );
    if (!registered.ok) {
      setError(registered.message);
      setBusy(false);
      return;
    }
    setRepository(registered.data);
    const starter = await clientApi<LocalKickstart>(
      "POST",
      `/v1/projects/${encodeURIComponent(created.id)}/repos/${encodeURIComponent(registered.data.id)}/local-kickstart`,
      { answers: startCommand.trim() ? { startCmd: startCommand.trim() } : {} },
    );
    if (starter.ok) setKickstart(starter.data);
    else setError(`Registered, but the starter configuration failed: ${starter.message}`);
    setBusy(false);
    router.refresh();
  }

  async function createBranch() {
    if (!project || !repository) return;
    setBusy(true);
    setError("");
    const result = await clientApi<LocalKickstartBranch>(
      "POST",
      `/v1/projects/${encodeURIComponent(project.id)}/repos/${encodeURIComponent(repository.id)}/local-kickstart/branch`,
      { answers: startCommand.trim() ? { startCmd: startCommand.trim() } : {} },
    );
    if (result.ok) setCreated(result.data);
    else setError(`Couldn't create the branch — ${result.message}. You can use the patch instead.`);
    setBusy(false);
  }

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <p className="text-[12.5px] leading-relaxed text-(--mut)">
        Agents work on Facility-managed copies in local Docker workspaces. You review, request
        revisions, and import approved commits back into your repository. No GitHub App or hosted
        remote is needed; model calls still go to your configured AI provider.
      </p>

      {statusError ? (
        <p className="text-sm text-(--bad)">
          Couldn't check local repository support — {statusError}
        </p>
      ) : status && !status.enabled ? (
        <div className="border border-(--line) bg-(--bg-subtle) p-5 text-sm leading-relaxed text-(--mut)">
          Local repositories are disabled on this Facility instance. An operator enables them by
          setting <code>FACILITY_LOCAL_REPOSITORY_ROOTS</code> to the directories Facility may read,
          then restarting the API and worker.
        </div>
      ) : null}

      {error ? (
        <div className="border border-(--bad) bg-(--bg-subtle) p-4 text-sm text-(--bad)">
          {error}
        </div>
      ) : null}

      {status?.enabled && !repository ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <Field label="Project name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field
            label="Repository path on the Facility host"
            hint={`Must be inside: ${status.roots.join(", ")}`}
          >
            <TextInput
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={`${status.roots[0] ?? "/path/to/code"}/my-app`}
              required
            />
          </Field>
          <Field
            label="Alias (optional)"
            hint="Used as local:<alias> in .facility.yml. Defaults to the folder name."
          >
            <TextInput value={alias} onChange={(event) => setAlias(event.target.value)} />
          </Field>
          <Field
            label="Development start command (optional)"
            hint="Used in the proposed .facility.yml."
          >
            <TextInput
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              placeholder="pnpm dev"
            />
          </Field>
          <p className="border border-(--line) p-4 text-[12.5px] leading-relaxed text-(--mut)">
            Facility imports <strong>committed history</strong> from the default branch only.
            Uncommitted and untracked files in your checkout are never copied. Facility never
            changes your checkout or an existing branch; it only creates new <code>facility/*</code>{" "}
            branches when you ask.
          </p>
          <div>
            <Button type="submit" disabled={busy || !slug || !path.trim()}>
              {busy ? "Registering…" : "Register repository"}
            </Button>
          </div>
        </form>
      ) : null}

      {repository ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Registered {repository.manifestName}</h2>
          <p className="text-sm text-(--mut)">
            {repository.sourcePath} · {repository.defaultBranch} at{" "}
            <span className="font-mono">{repository.headSha.slice(0, 12)}</span>
          </p>
          {repository.warnings.map((warning) => (
            <p key={warning} className="text-sm text-(--human)">
              {warning}
            </p>
          ))}
          {kickstart ? (
            kickstart.files.length === 0 ? (
              <p className="text-sm text-(--mut)">
                The repository already has .facility.yml and its agents. Start a story when you're
                ready.
              </p>
            ) : (
              <>
                {created ? (
                  <>
                    <p className="text-sm text-(--mut)">
                      Created branch <code>{created.branch}</code> at commit{" "}
                      <span className="font-mono">{created.commitSha.slice(0, 12)}</span> in your
                      repository. Your checkout is unchanged. Review and merge it from inside the
                      repository:
                    </p>
                    <pre className="overflow-auto bg-(--bg-subtle) p-3 text-[11.5px]">
                      {created.instructions.join("\n")}
                    </pre>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-(--mut)">
                      Facility can commit the starter configuration to a new branch,{" "}
                      <code>{kickstart.branch}</code>, on top of {repository.defaultBranch}. It
                      won't touch your checkout or any existing branch, and you merge it yourself:
                    </p>
                    <ul className="font-mono text-[11.5px] text-(--mut)">
                      {kickstart.files.map((file) => (
                        <li key={file.path}>{file.path}</li>
                      ))}
                    </ul>
                    <div>
                      <Button type="button" disabled={busy} onClick={() => void createBranch()}>
                        {busy ? "Creating…" : `Create branch ${kickstart.branch}`}
                      </Button>
                    </div>
                  </>
                )}
                {created ? null : (
                  <details className="text-sm text-(--mut)">
                    <summary className="cursor-pointer">Use a patch instead</summary>
                    <p className="mt-3">
                      Save this as <code>facility-kickstart.patch</code> in your repository, then
                      apply and commit it:
                    </p>
                    <pre className="mt-3 overflow-auto bg-(--bg-subtle) p-3 text-[11.5px]">
                      {kickstart.instructions.join("\n")}
                    </pre>
                    <textarea
                      readOnly
                      aria-label="Starter configuration patch"
                      className="mt-3 h-72 w-full border border-(--line) bg-(--bg-subtle) p-3 font-mono text-[11.5px]"
                      value={kickstart.patch}
                    />
                  </details>
                )}
              </>
            )
          ) : null}
          {project ? (
            <div>
              <Link
                className="text-(--info) underline"
                href={`/projects/${encodeURIComponent(project.id)}`}
              >
                Open the project →
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
