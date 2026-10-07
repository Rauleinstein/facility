-- A local repository is identified by its canonical Git common directory, which
-- every worktree and path of one repository shares. Rows registered before this
-- column existed are backfilled with the common directory of an ordinary
-- checkout; a worktree or bare row then fails verification and is registered again.
ALTER TABLE project_repositories ADD COLUMN source_repository text;
UPDATE project_repositories
  SET source_repository = source_path || '/.git'
  WHERE source = 'local' AND source_repository IS NULL;

ALTER TABLE project_repositories
  DROP CONSTRAINT project_repositories_source_shape_check,
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

DROP INDEX IF EXISTS project_repositories_local_path_idx;
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

DROP TRIGGER IF EXISTS project_repositories_local_owner_guard ON project_repositories;
CREATE TRIGGER project_repositories_local_owner_guard
BEFORE INSERT OR UPDATE OF source, source_repository, org_id
ON project_repositories
FOR EACH ROW
EXECUTE FUNCTION enforce_local_repository_owner();

-- Object ids are SHA-1 (40) or SHA-256 (64) hex; nothing in between.
ALTER TABLE story_exports
  DROP CONSTRAINT story_exports_sha_check,
  ADD CONSTRAINT story_exports_sha_check CHECK (
    base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' AND head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  );
