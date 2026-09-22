# Local repository workflow

Facility can run a project from a repository already available on the Facility host. This mode does not require a GitHub App installation.

With the Docker Compose deployment, the source must be under `/srv/facility-repositories` (or the host directory supplied through `FACILITY_LOCAL_REPOSITORIES_ROOT`, mounted at that same path in the API and worker containers). The same host path is bind-mounted read-only into each workspace container.

## Configure a project

Create the project through the API with an explicit `local` repository source:

```bash
curl -X POST "$FACILITY_URL/v1/projects" \
  -H "Authorization: Bearer $FACILITY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Local app",
    "slug": "local-app",
    "settings": {
      "repositorySource": {
        "type": "local",
        "path": "/srv/facility-repositories/app",
        "name": "app",
        "defaultBranch": "main"
      }
    }
  }'
```

For a bare local Git remote, use `remote` instead of `path`:

```json
{"type":"local","remote":"file:///srv/facility-repositories/app.git","name":"app","defaultBranch":"main"}
```

The source must contain `.facility.yml`. Start a story through the normal API/CLI workflow; Docker workspaces clone the configured local source, create the story branch, run the configured agent, and expose the normal local preview endpoints.

## Security limitations

- The path or `file://` remote is read by the Facility API process and is trusted operator configuration. Do not accept it directly from untrusted users. In Docker Compose it must be under the mounted repository root described above.
- Facility can read and execute code from the configured repository inside the workspace. Use a dedicated host path and least-privilege filesystem permissions.
- Local mode supplies no GitHub credentials and never calls GitHub clone URLs. GitHub issue, pull-request, CI, and webhook operations are unavailable unless the project is configured with the default GitHub source.
- Local remotes are not uploaded, pushed, or synchronized by Facility. Back up and protect the host repository separately.
- Docker workspace isolation is still required; local mode does not make repository code safe to run on the host.
