-- Migration date: 2026-09-16
-- Record, on the upload file row, the moment the worker wrote the destination
-- documents row for a `document_create` upload.
--
-- Why: a retried upload must not resurrect a document the user deleted while
-- the first attempt was running, but it also must not give up when the first
-- attempt failed BEFORE the row existed (a storage read error, a transient
-- database error on the upsert itself). Nothing durable distinguished those
-- two "row is missing on retry" cases; the attempt counter cannot. This
-- column can: it is set only after the upsert succeeded, so on a retry
--   marker set   + row missing  => the row was deleted, stop for good;
--   marker unset + row missing  => the row was never written, create it.
-- Existing rows stay null, which reads as "never written" and lets any
-- in-flight retry proceed exactly as it did before this migration.
alter table public.upload_session_files
  add column if not exists document_created_at timestamptz;
