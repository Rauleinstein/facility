-- An organization admits members either through an active GitHub App
-- installation or, when it is explicitly in local mode, without one. Local mode
-- is recorded rather than inferred from missing installation rows, so deleting
-- an installation never admits a GitHub organization.
ALTER TABLE orgs
  ADD COLUMN access_mode text NOT NULL DEFAULT 'github',
  ADD CONSTRAINT orgs_access_mode_check CHECK (access_mode in ('github', 'local'));
