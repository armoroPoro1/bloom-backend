-- Metadata deletion and this durable retry record commit together. The original
-- upload row is intentionally not referenced: it has already been removed.
CREATE TABLE upload_deletion_jobs (
 id uuid PRIMARY KEY,
 storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 available_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_deletion_jobs_available_idx ON upload_deletion_jobs(available_at,created_at,id) WHERE locked_at IS NULL;
CREATE INDEX upload_deletion_jobs_leased_idx ON upload_deletion_jobs(locked_at) WHERE locked_at IS NOT NULL;
