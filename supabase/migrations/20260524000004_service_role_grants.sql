-- Grant DML privileges to service_role on all tables that were locked down
-- by the hardening migration (20260521000000_baseline.sql / 20260524000000_rls_deny_all.sql).
--
-- Those migrations revoked all access from anon and authenticated so that
-- clients cannot hit Supabase directly, but they did not add explicit grants
-- to service_role. Without these grants the API (which authenticates with the
-- service role key) gets "permission denied for table …" errors even though
-- service_role has BYPASSRLS.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.user_profiles,
  public.projects,
  public.project_subfolders,
  public.documents,
  public.document_versions,
  public.document_edits,
  public.workflows,
  public.hidden_workflows,
  public.workflow_shares,
  public.chats,
  public.chat_messages,
  public.tabular_reviews,
  public.tabular_cells,
  public.tabular_review_chats,
  public.tabular_review_chat_messages,
  public.user_api_keys
TO service_role;
