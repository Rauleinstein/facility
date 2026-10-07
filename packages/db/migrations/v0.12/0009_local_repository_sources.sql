-- Local repositories are a second repository source beside GitHub. Existing rows
-- keep their GitHub identity and behavior; a local row is identified by a
-- project-scoped alias, the canonical host path it was registered from, and its
-- canonical Git common directory, which every worktree and path of one
-- repository shares.
ALTER TABLE project_repositories
  ADD COLUMN source text NOT NULL DEFAULT 'github',
  ADD COLUMN source_path text,
  ADD COLUMN source_repository text,
  ADD CONSTRAINT project_repositories_source_check CHECK (source in ('github', 'local')),
  ADD CONSTRAINT project_repositories_source_shape_check CHECK (
    (
      source = 'github'
      AND source_path IS NULL
      AND source_repository IS NULL
      AND owner <> '_local'
    )
    OR (
      source = 'local'
      AND owner = '_local'
      AND installation_id IS NULL
      AND source_path IS NOT NULL
      AND left(source_path, 1) = '/'
      AND source_repository IS NOT NULL
      AND left(source_repository, 1) = '/'
    )
  );

-- GitHub identities stay unique per organization. Local aliases cannot occupy
-- that namespace, and a local path is registered at most once per project.
ALTER TABLE project_repositories DROP CONSTRAINT project_repositories_org_owner_name_uidx;
CREATE UNIQUE INDEX project_repositories_org_owner_name_uidx
  ON project_repositories (org_id, owner, name) WHERE source = 'github';
CREATE UNIQUE INDEX project_repositories_local_alias_uidx
  ON project_repositories (project_id, lower(name)) WHERE source = 'local';
CREATE UNIQUE INDEX project_repositories_local_path_uidx
  ON project_repositories (project_id, source_path) WHERE source = 'local';
CREATE INDEX project_repositories_local_repository_idx
  ON project_repositories (source_repository) WHERE source = 'local';

-- One organization owns a host repository, whichever worktree or path registered
-- it. A unique index cannot say "unique across organizations", so a trigger
-- serializes claims per repository and refuses a second organization.
CREATE OR REPLACE FUNCTION enforce_local_repository_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source = 'local' THEN
    PERFORM pg_advisory_xact_lock(hashtext('facility:local-repository:' || NEW.source_repository));
    IF EXISTS (
      SELECT 1 FROM project_repositories
      WHERE source = 'local'
        AND source_repository = NEW.source_repository
        AND org_id <> NEW.org_id
    ) THEN
      RAISE EXCEPTION 'local repository % is registered by another organization', NEW.source_repository
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'project_repositories_local_owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_repositories_local_owner_guard
BEFORE INSERT OR UPDATE OF source, source_repository, org_id
ON project_repositories
FOR EACH ROW
EXECUTE FUNCTION enforce_local_repository_owner();

-- The source commit imported into each workspace repository. Refreshing is an
-- explicit operation that records a new revision; it never moves a story branch.
ALTER TABLE workspaces
  ADD COLUMN source_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT workspaces_source_revisions_check CHECK (
    jsonb_typeof(source_revisions) = 'object'
  );

-- Reviewed local results handed back to the user's repository. An export is not a
-- merge: it records exactly which approved commit range was packaged.
CREATE TABLE story_exports (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  review_event_id text NOT NULL REFERENCES story_evidence_events(id),
  branch text NOT NULL,
  base_sha text NOT NULL,
  head_sha text NOT NULL,
  commit_count integer NOT NULL,
  bundle bytea NOT NULL,
  bundle_sha256 text NOT NULL,
  patch text NOT NULL,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_exports_commit_count_check CHECK (commit_count > 0),
  -- Object ids are SHA-1 (40) or SHA-256 (64) hex; nothing in between.
  CONSTRAINT story_exports_sha_check CHECK (
    base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' AND head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  CONSTRAINT story_exports_story_scope_fk FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_exports_repository_scope_fk FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX story_exports_story_created_idx ON story_exports (org_id, story_id, created_at DESC);
