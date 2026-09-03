// Business logic + data access for the workflows module.
//
// These functions take an explicit Supabase client (`db`) plus
// request-derived primitives, perform the workflow / share / hidden-list /
// asset orchestration, and RETURN typed results. They never touch
// req/res — the thin route handlers in workflows.routes.ts map the results
// onto HTTP status codes and response bodies.

import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/supabase";
export type { Db };
import {
  catalogWorkflowToLegacy,
  ensureDefaultWorkflows,
  findCatalogWorkflow,
  listActiveCatalogWorkflows,
  type LegacyCatalogWorkflow,
} from "../../lib/workflowCatalog";
import {
  findMissingUserEmails,
  loadProfileUsersByEmail,
} from "../../lib/userLookup";
import { workflowNameFromSkillMd } from "./workflows.name";
import type { PaginationParams } from "../../lib/pagination";
import type { WorkflowSort } from "../../lib/sort";
import {
  buildWorkflowIdsOverviewRpcArgs,
  buildWorkflowsOverviewRpcArgs,
  type WorkflowScope,
} from "./workflows.overview";
import {
  checkWorkflowAccess,
  ensureDocAccess,
  getOrgRole,
} from "../../lib/access";
import { can, type ProjectRole } from "../../lib/permissions";
import {
  deleteOrgAccessOverride,
  findOrgMemberByEmail,
  isOrgAssignableRole,
  listOrgAccessPeople,
  setOrgAccessOverride,
} from "../../lib/orgAccessOverrides";
import { ensureResourceAccessSummaries } from "../../lib/resourceAccessSummary";
import { convertedPdfKey } from "../../lib/convert";
import { copyFile, storageKey } from "../../lib/storage";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../../lib/documentVersions";
// devLog comes from lib/chat/types (a leaf file — importing the whole chat
// barrel here just for a logger would be a heavy dependency edge).
import { devLog } from "../../lib/chat/types";

// Unexpected data-access failures travel back to the route as the raw error
// object. The route logs it and answers with the opaque internal-error body
// from lib/httpError, so driver messages never reach the client.
export type ServiceFailure = { ok: false; error: unknown };

export type WorkflowRecord = {
  id: string;
  user_id: string | null;
  org_id?: string | null;
  access_scope?: "private" | "shared" | "organization";
  organization_name?: string | null;
  direct_grant_count?: number;
  is_system?: boolean;
  title?: string;
  type?: string;
  prompt_md?: string | null;
  columns_config?: unknown;
  language?: string | null;
  version?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
  created_at?: string;
  [key: string]: unknown;
};

export type WorkflowType = "assistant" | "tabular";

export type WorkflowContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};

export type WorkflowMetadata = {
  name: string | null;
  title: string;
  description: string | null;
  type: WorkflowType;
  contributors: WorkflowContributor[];
  language: string;
  version: string | null;
  practice: string | null;
  jurisdictions: string[] | null;
};
export type OpenSourceSubmissionStatus = "pending" | "approved" | "rejected";

export type OpenSourceSubmissionRow = {
  id: string;
  workflow_id: string;
  submitted_by_user_id: string;
  submitter_email: string | null;
  submitter_name: string | null;
  contributor_mode?: "named" | "anonymous";
  status: OpenSourceSubmissionStatus;
  snapshot: unknown;
  submitted_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  review_notes?: string | null;
};

export type OpenSourceSubmissionSummary = Pick<
  OpenSourceSubmissionRow,
  "id" | "status" | "submitted_at" | "updated_at"
> & {
  reviewed_at?: string | null;
};

const DEFAULT_WORKFLOW_CONTRIBUTOR: WorkflowContributor = {
  name: "Mike",
  organisation: null,
  role: null,
  linkedin: null,
};
const DEFAULT_WORKFLOW_LANGUAGE = "English";
const DEFAULT_WORKFLOW_PRACTICE = "General Transactions";
const DEFAULT_WORKFLOW_JURISDICTIONS = ["General"];
export const WORKFLOW_CONTRIBUTIONS_ENABLED =
  process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true";

export type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      role: ProjectRole;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;

function withWorkflowAccess<T extends object>(
  workflow: T,
  access: {
    role: ProjectRole;
    allowEdit: boolean;
    isOwner: boolean;
    sharedByName?: string | null;
  },
) {
  return {
    ...workflow,
    access_role: access.role,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

function withOpenSourceSubmission<T extends object>(
  workflow: T,
  submission: OpenSourceSubmissionSummary | null,
) {
  return {
    ...workflow,
    open_source_submission: submission,
  };
}

export function withSystemWorkflowAccess(workflow: LegacyCatalogWorkflow) {
  return withWorkflowAccess(workflow, {
    role: "viewer",
    allowEdit: false,
    isOwner: false,
  });
}

// The built-in workflows now live in the `mike_workflows` catalog table
// rather than a compiled-in constant, so the lookup is a query and the
// catalog row is projected back into the legacy system-workflow shape.
export async function findSystemWorkflow(
  db: Db,
  workflowId: string,
): Promise<LegacyCatalogWorkflow | null> {
  const catalogWorkflow = await findCatalogWorkflow(workflowId, db);
  return catalogWorkflow ? catalogWorkflowToLegacy(catalogWorkflow) : null;
}

// Retained as a compatibility listing for older clients. The restructured
// Workflows page no longer exposes a System tab; non-default catalog entries
// are presented through /workflow-addons instead.
export async function listSystemWorkflows(
  db: Db,
  workflowType: WorkflowType | null,
) {
  const catalog = await listActiveCatalogWorkflows(db, { type: workflowType });
  return catalog.map(catalogWorkflowToLegacy).map(withSystemWorkflowAccess);
}

function workflowTypeFrom(value: unknown): WorkflowType {
  return value === "tabular" ? "tabular" : "assistant";
}

function assetsUnsupported(access: NonNullable<WorkflowAccess>) {
  return workflowTypeFrom(access.workflow.type) !== "assistant";
}

function metadataFromWorkflowRecord(
  workflow: WorkflowRecord,
): WorkflowMetadata {
  const type = workflowTypeFrom(workflow.type);
  return {
    name: workflowNameFromSkillMd(workflow.prompt_md),
    title: workflow.title ?? "",
    description: null,
    type,
    contributors: normalizeContributors(workflow.contributors) ?? [
      DEFAULT_WORKFLOW_CONTRIBUTOR,
    ],
    language: workflow.language ?? DEFAULT_WORKFLOW_LANGUAGE,
    version: workflow.version ?? null,
    practice: workflow.practice ?? DEFAULT_WORKFLOW_PRACTICE,
    jurisdictions: workflow.jurisdictions ?? DEFAULT_WORKFLOW_JURISDICTIONS,
  };
}

function withDatabaseWorkflow(workflow: WorkflowRecord) {
  const {
    title: _title,
    type: _type,
    contributors: _contributors,
    language: _language,
    version: _version,
    practice: _practice,
    jurisdictions: _jurisdictions,
    prompt_md,
    ...rest
  } = workflow;
  return {
    ...rest,
    metadata: metadataFromWorkflowRecord(workflow),
    skill_md: prompt_md ?? null,
    is_system: false,
  };
}

function withDatabaseWorkflowSummary(workflow: WorkflowRecord) {
  return {
    ...withDatabaseWorkflow(workflow),
    // List pages only need metadata. The detail route loads the full content.
    skill_md: null,
    columns_config: null,
  };
}

async function markDefaultWorkflows<T extends { id: string }>(
  db: Db,
  userId: string,
  workflows: T[],
): Promise<Array<T & { is_default: boolean; default_key: string | null }>> {
  if (workflows.length === 0) return [];
  const { data, error } = await db
    .from("default_workflow_installations")
    .select("workflow_id, default_key")
    .eq("user_id", userId)
    .in(
      "workflow_id",
      workflows.map((workflow) => workflow.id),
    );
  if (error) throw error;
  const defaultKeyByWorkflowId = new Map(
    (data ?? []).flatMap((row) =>
      row.workflow_id && row.default_key
        ? [[row.workflow_id, row.default_key] as const]
        : [],
    ),
  );
  return workflows.map((workflow) => ({
    ...workflow,
    is_default: defaultKeyByWorkflowId.has(workflow.id),
    default_key: defaultKeyByWorkflowId.get(workflow.id) ?? null,
  }));
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeJurisdictions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => !!item);
  return items.length > 0 ? Array.from(new Set(items)) : null;
}

function normalizeContributors(value: unknown): WorkflowContributor[] | null {
  if (!Array.isArray(value)) return null;
  const contributors = value
    .map((item): WorkflowContributor | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const name = normalizeOptionalString(record.name);
      if (!name) return null;
      return {
        name,
        organisation: normalizeOptionalString(record.organisation),
        role: normalizeOptionalString(record.role),
        linkedin: normalizeOptionalString(record.linkedin),
      };
    })
    .filter((item): item is WorkflowContributor => !!item);
  return contributors.length ? contributors : null;
}

function contributorFromName(name: unknown): WorkflowContributor {
  return {
    ...DEFAULT_WORKFLOW_CONTRIBUTOR,
    name: normalizeOptionalString(name) ?? DEFAULT_WORKFLOW_CONTRIBUTOR.name,
  };
}

async function resolveWorkflowAccess(
  db: Db,
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const verdict = await checkWorkflowAccess(workflowId, userId, userEmail, db);
  if (!verdict.ok) return null;
  return {
    workflow: workflow as WorkflowRecord,
    role: verdict.projectRole,
    allowEdit: can(verdict.projectRole, "content.edit"),
    isOwner: can(verdict.projectRole, "access.manage"),
  };
}

// Owner-scoped workflow operations use the same effective resource role as
// the rest of the application. The creator is always an Owner, an org Admin
// defaults to Owner, and explicit organization overrides may assign another
// member Owner access.
async function resolveCreatorScopedWorkflow(
  db: Db,
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowRecord | null> {
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  return access?.isOwner ? access.workflow : null;
}

// Installs any missing default catalog workflows for the user (cached
// per-process inside ensureDefaultWorkflows, so repeat calls are cheap).
// The raw error is handed back so the route can log it and answer with the
// opaque internal-error body instead of leaking the driver's message.
export async function ensureDefaultsInstalled(
  db: Db,
  userId: string,
): Promise<ServiceFailure | { ok: true }> {
  try {
    await ensureDefaultWorkflows(userId, db);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function listWorkflows(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: string | null;
  },
): Promise<{ ok: true; data: unknown } | ServiceFailure> {
  const { userId, userEmail, type: workflowType } = params;
  const { data, error } = await db.rpc("get_workflows_overview", {
    p_user_id: userId,
    p_user_email: userEmail ?? null,
    p_type: workflowType,
  });
  if (error) {
    return { ok: false, error };
  }

  const accessSummary = await ensureResourceAccessSummaries(
    db,
    "workflow",
    (data ?? []) as WorkflowRecord[],
  );
  if (accessSummary.error) return { ok: false, error: accessSummary.error };
  const databaseWorkflows = accessSummary.rows.map(withDatabaseWorkflow);
  return {
    ok: true,
    data: await markDefaultWorkflows(db, userId, databaseWorkflows),
  };
}

export async function listWorkflowsPage(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: string | null;
    scope: WorkflowScope;
    pagination: PaginationParams;
    searchTerm: string | null;
    sort: WorkflowSort;
    practice: string | null;
    language: string | null;
    jurisdiction: string | null;
  },
): Promise<{ ok: true; data: unknown } | ServiceFailure> {
  const rpcArgs = buildWorkflowsOverviewRpcArgs(params);
  const { data, error } = await db.rpc("get_workflows_overview", rpcArgs);
  if (error) return { ok: false, error };
  const accessSummary = await ensureResourceAccessSummaries(
    db,
    "workflow",
    (data ?? []) as WorkflowRecord[],
  );
  if (accessSummary.error) return { ok: false, error: accessSummary.error };
  const workflows = accessSummary.rows.map(withDatabaseWorkflowSummary);
  return {
    ok: true,
    data: await markDefaultWorkflows(db, params.userId, workflows),
  };
}

export async function getWorkflowFilterOptions(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: WorkflowType | null;
    scope: WorkflowScope;
  },
): Promise<
  | {
      ok: true;
      options: {
        practices: string[];
        languages: string[];
        jurisdictions: string[];
      };
    }
  | ServiceFailure
> {
  const { data, error } = await db.rpc("get_workflow_filter_options", {
    p_user_id: params.userId,
    p_user_email: params.userEmail ?? null,
    p_type: params.type,
    p_scope: params.scope,
  });
  if (error) return { ok: false, error };

  const row = (data?.[0] ?? {}) as Record<string, unknown>;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    ok: true,
    options: {
      practices: strings(row.practices),
      languages: strings(row.languages),
      jurisdictions: strings(row.jurisdictions),
    },
  };
}

const WORKFLOW_IDS_PAGE_SIZE = 1000;
const WORKFLOW_IDS_MAX_PAGES = 200;

export async function listWorkflowIds(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: string | null;
    scope: WorkflowScope;
    searchTerm: string | null;
    practice: string | null;
    language: string | null;
    jurisdiction: string | null;
  },
): Promise<
  | { ok: true; ids: { id: string; user_id: string }[] }
  | ServiceFailure
> {
  const ids: { id: string; user_id: string }[] = [];
  let offset = 0;
  for (let page = 0; page < WORKFLOW_IDS_MAX_PAGES; page += 1) {
    const rpcArgs = buildWorkflowIdsOverviewRpcArgs({
      ...params,
      pagination: { limit: WORKFLOW_IDS_PAGE_SIZE, offset },
    });
    const { data, error } = await db.rpc("get_workflow_ids_overview", rpcArgs);
    if (error) return { ok: false, error };
    const rows = (data ?? []) as { id: string; user_id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows);
    offset += rows.length;
  }
  return { ok: true, ids };
}

export type CreateWorkflowResult =
  | { ok: true; workflow: Record<string, unknown> }
  | { ok: false; kind: "validation"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

export async function createWorkflow(
  db: Db,
  params: {
    userId: string;
    title: string;
    type: WorkflowType;
    skill_md?: string;
    columns_config?: unknown;
    metadata?: Partial<WorkflowMetadata>;
    org_id?: unknown;
  },
): Promise<CreateWorkflowResult> {
  const {
    userId,
    title,
    type,
    skill_md,
    columns_config,
    metadata,
    org_id,
  } = params;
  // Tenant assignment, exactly as POST /projects does it: an explicit
  // org_id must be one the caller belongs to, and its absence means
  // personal (org_id stays NULL, which IS the representation of personal
  // now that hidden personal orgs are gone). Workflows have no project to
  // inherit from, so an explicit id is the only context available.
  let orgId: string | null = null;
  if (org_id != null) {
    if (typeof org_id !== "string" || !org_id.trim())
      return {
        ok: false,
        kind: "validation",
        detail: "org_id must be a non-empty string",
      };
    const role = await getOrgRole(userId, org_id, db);
    if (!role)
      return {
        ok: false,
        kind: "validation",
        detail: "You are not a member of that organization.",
      };
    orgId = org_id;
  }
  devLog("[workflows/create] request", {
    userId,
    title: title.trim(),
    type,
    hasSkill: typeof skill_md === "string" && skill_md.length > 0,
    columnCount: Array.isArray(columns_config) ? columns_config.length : null,
    language:
      normalizeOptionalString(metadata?.language) ?? DEFAULT_WORKFLOW_LANGUAGE,
    practice: metadata?.practice ?? null,
    jurisdictions:
      normalizeJurisdictions(metadata?.jurisdictions) ??
      DEFAULT_WORKFLOW_JURISDICTIONS,
  });
  const { data, error } = await db
    .from("workflows")
    .insert({
      user_id: userId,
      title: title.trim(),
      type,
      prompt_md: skill_md ?? null,
      columns_config: columns_config ?? null,
      language:
        normalizeOptionalString(metadata?.language) ??
        DEFAULT_WORKFLOW_LANGUAGE,
      practice:
        normalizeOptionalString(metadata?.practice) ??
        DEFAULT_WORKFLOW_PRACTICE,
      jurisdictions:
        normalizeJurisdictions(metadata?.jurisdictions) ??
        DEFAULT_WORKFLOW_JURISDICTIONS,
      org_id: orgId,
    })
    .select("*")
    .single();
  if (error) {
    devLog("[workflows/create] insert error", {
      userId,
      title: title.trim(),
      type,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return { ok: false, kind: "db_error", error };
  }
  devLog("[workflows/create] inserted", {
    id: data?.id,
    user_id: data?.user_id,
    title: data?.title,
    type: data?.type,
  });
  return {
    ok: true,
    workflow: withWorkflowAccess(
      withDatabaseWorkflow({
        ...(data as WorkflowRecord),
        access_scope: orgId ? "organization" : "private",
        organization_name: null,
      }),
      {
        role: "owner",
        allowEdit: true,
        isOwner: true,
      },
    ),
  };
}

export type UpdateWorkflowResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_editable" };

export async function updateWorkflow(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    body: {
      metadata?: Partial<WorkflowMetadata>;
      skill_md?: unknown;
      columns_config?: unknown;
    };
  },
): Promise<UpdateWorkflowResult> {
  const { workflowId, userId, userEmail, body } = params;
  const updates: Record<string, unknown> = {};
  const metadata = body.metadata;
  if (metadata?.title != null) updates.title = metadata.title;
  if (body.skill_md != null) updates.prompt_md = body.skill_md;
  if (body.columns_config != null)
    updates.columns_config = body.columns_config;
  if (metadata && "language" in metadata)
    updates.language = normalizeOptionalString(metadata.language);
  if (metadata && "practice" in metadata)
    updates.practice = metadata.practice ?? null;
  if (metadata && "jurisdictions" in metadata)
    updates.jurisdictions = normalizeJurisdictions(metadata.jurisdictions);

  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access || !access.allowEdit) {
    return { ok: false, kind: "not_editable" };
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .select("*")
    .single();
  if (error || !data) return { ok: false, kind: "not_editable" };
  return {
    ok: true,
    body: withWorkflowAccess(withDatabaseWorkflow(data as WorkflowRecord), {
      role: access.role,
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  };
}

export type DeleteWorkflowResult =
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function deleteWorkflow(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    workflowId: string;
  },
): Promise<DeleteWorkflowResult> {
  const { userId, userEmail, workflowId } = params;
  const workflow = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!workflow) return { ok: false, kind: "not_found" };

  // Asset files are collected by workflow, not by creator: on a detached
  // workflow their user_id is NULL too, and scoping the cleanup to the
  // caller would orphan the storage objects the row delete is about to
  // strand.
  const { data: assets } = await db
    .from("documents")
    .select("id")
    .eq("workflow_id", workflowId);
  const assetIds = (assets ?? []).map((asset) => asset.id as string);
  const { data: assetVersions } = assetIds.length
    ? await db
        .from("document_versions")
        .select("storage_path, pdf_storage_path")
        .in("document_id", assetIds)
    : { data: [] };
  const { data: deleted, error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .select("id");
  if (error) return { ok: false, kind: "db_error", error };
  if ((deleted ?? []).length > 0) {
    // Durable storage.cleanup job — previously fire-and-forget deletes
    // that leaked the files on any storage hiccup.
    await enqueueStorageCleanup(
      db,
      (assetVersions ?? []).flatMap((version) =>
        [version.storage_path, version.pdf_storage_path].filter(
          (path): path is string => !!path,
        ),
      ),
    );
  }
  return { ok: true };
}

export async function getWorkflowDetail(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const { workflowId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access) return { ok: false };
  const openSourceSubmission = access.isOwner
    ? await getLatestOpenSourceSubmission(db, workflowId, userId)
    : null;
  const { data: installation } = access.isOwner
    ? await db
        .from("default_workflow_installations")
        .select("id")
        .eq("workflow_id", workflowId)
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null };
  return {
    ok: true,
    body: {
      ...withOpenSourceSubmission(
        withWorkflowAccess(withDatabaseWorkflow(access.workflow), {
          role: access.role,
          allowEdit: access.allowEdit,
          isOwner: access.isOwner,
        }),
        openSourceSubmission,
      ),
      is_default: !!installation,
    },
  };
}

function toOpenSourceSubmissionSummary(
  row: OpenSourceSubmissionRow,
): OpenSourceSubmissionSummary {
  return {
    id: row.id,
    status: row.status,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    reviewed_at: row.reviewed_at ?? null,
  };
}

async function getLatestOpenSourceSubmission(
  db: Db,
  workflowId: string,
  userId: string,
): Promise<OpenSourceSubmissionSummary | null> {
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .select("id, status, submitted_at, updated_at, reviewed_at")
    .eq("workflow_id", workflowId)
    .eq("submitted_by_user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data
    ? toOpenSourceSubmissionSummary(data as OpenSourceSubmissionRow)
    : null;
}

function buildOpenSourceSnapshot(
  workflow: WorkflowRecord,
  contributors: WorkflowContributor[],
  contributorMode: "named" | "anonymous",
) {
  return {
    workflow_id: workflow.id,
    metadata: {
      ...metadataFromWorkflowRecord(workflow),
      contributors,
    },
    skill_md: workflow.prompt_md ?? null,
    columns_config: workflow.columns_config ?? null,
    contributor_mode: contributorMode,
    created_at: workflow.created_at ?? null,
  };
}

function validateOpenSourceWorkflow(workflow: WorkflowRecord): string | null {
  if (workflow.type === "assistant") {
    return typeof workflow.prompt_md === "string" && workflow.prompt_md.trim()
      ? null
      : "Assistant workflows need instructions before they can be opened source.";
  }
  if (workflow.type === "tabular") {
    return Array.isArray(workflow.columns_config) &&
      workflow.columns_config.length > 0
      ? null
      : "Tabular workflows need at least one column before they can be opened source.";
  }
  return "Workflow type must be 'assistant' or 'tabular'.";
}

export type SubmitOpenSourceWorkflowResult =
  | {
      ok: true;
      status: number;
      body: OpenSourceSubmissionSummary & { mode: "created" | "updated" };
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "validation"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

export async function submitOpenSourceWorkflow(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    body: { contributor_mode?: unknown; contributor?: unknown };
  },
): Promise<SubmitOpenSourceWorkflowResult> {
  const { workflowId, userId, userEmail, body: openSourceBody } = params;
  const requestedContributorMode =
    openSourceBody.contributor_mode === "named" ? "named" : "anonymous";

  const { data: workflow, error: workflowError } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (workflowError) {
    return { ok: false, kind: "db_error", error: workflowError };
  }
  if (!workflow) {
    return { ok: false, kind: "not_found" };
  }

  const workflowRecord = workflow as WorkflowRecord;
  const validationError = validateOpenSourceWorkflow(workflowRecord);
  if (validationError) {
    return { ok: false, kind: "validation", detail: validationError };
  }

  const { data: profile } = await db
    .from("user_profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();
  const submitterName =
    typeof profile?.display_name === "string" && profile.display_name.trim()
      ? profile.display_name.trim()
      : null;
  const submittedContributor =
    normalizeContributors([openSourceBody.contributor])?.[0] ??
    contributorFromName(submitterName || userEmail);
  const publicContributors =
    requestedContributorMode === "named"
      ? [submittedContributor]
      : [DEFAULT_WORKFLOW_CONTRIBUTOR];
  const now = new Date().toISOString();
  const snapshot = buildOpenSourceSnapshot(
    workflowRecord,
    publicContributors,
    requestedContributorMode,
  );

  const { data: pendingSubmission, error: pendingError } = await db
    .from("workflow_open_source_submissions")
    .select("*")
    .eq("workflow_id", workflowId)
    .eq("submitted_by_user_id", userId)
    .eq("status", "pending")
    .maybeSingle();
  if (pendingError) {
    return { ok: false, kind: "db_error", error: pendingError };
  }

  if (pendingSubmission) {
    const { data: updated, error: updateError } = await db
      .from("workflow_open_source_submissions")
      .update({
        submitter_email: userEmail ?? null,
        submitter_name:
          requestedContributorMode === "named" ? submitterName : null,
        contributor_mode: requestedContributorMode,
        snapshot,
        updated_at: now,
      })
      .eq("id", pendingSubmission.id)
      .select("id, status, submitted_at, updated_at, reviewed_at")
      .single();
    if (updateError || !updated) {
      return {
        ok: false,
        kind: "db_error",
        error: updateError ?? new Error("Submission update returned no data"),
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        ...toOpenSourceSubmissionSummary(updated as OpenSourceSubmissionRow),
        mode: "updated",
      },
    };
  }

  const { data: created, error: createError } = await db
    .from("workflow_open_source_submissions")
    .insert({
      workflow_id: workflowId,
      submitted_by_user_id: userId,
      submitter_email: userEmail ?? null,
      submitter_name:
        requestedContributorMode === "named" ? submitterName : null,
      contributor_mode: requestedContributorMode,
      status: "pending",
      snapshot,
      submitted_at: now,
      updated_at: now,
    })
    .select("id, status, submitted_at, updated_at, reviewed_at")
    .single();
  if (createError || !created) {
    return {
      ok: false,
      kind: "db_error",
      error: createError ?? new Error("Submission create returned no data"),
    };
  }

  return {
    ok: true,
    status: 201,
    body: {
      ...toOpenSourceSubmissionSummary(created as OpenSourceSubmissionRow),
      mode: "created",
    },
  };
}

export async function listHiddenWorkflows(
  db: Db,
  userId: string,
): Promise<{ ok: true; ids: unknown[] } | ServiceFailure> {
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return { ok: false, error };
  return { ok: true, ids: (data ?? []).map((r) => r.workflow_id) };
}

export async function hideWorkflow(
  db: Db,
  userId: string,
  workflowId: string,
): Promise<{ ok: true } | ServiceFailure> {
  const { error } = await db
    .from("hidden_workflows")
    .upsert(
      { user_id: userId, workflow_id: workflowId },
      { onConflict: "user_id,workflow_id" },
    );
  if (error) return { ok: false, error };
  return { ok: true };
}

export async function unhideWorkflow(
  db: Db,
  userId: string,
  workflowId: string,
): Promise<{ ok: true } | ServiceFailure> {
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return { ok: false, error };
  return { ok: true };
}

// --- Assets (assistant workflows only) -------------------------------------
//
// Workflow assets are ordinary `documents` rows tagged with the owning
// workflow plus `library_kind: "workflow_asset"`. They are created by copying
// an already-accessible document's current version rather than by uploading
// bytes, so every source document is authorization-checked individually.

const MAX_WORKFLOW_ASSET_SOURCES = 50;

export type WorkflowAssetFailure =
  | { ok: false; kind: "workflow_not_found" }
  | { ok: false; kind: "not_editable" }
  | { ok: false; kind: "tabular_unsupported" }
  | { ok: false; kind: "asset_not_found" }
  | { ok: false; kind: "documents_not_found" }
  | { ok: false; kind: "documents_not_ready" }
  | { ok: false; kind: "db_error"; error: unknown };

type WorkflowAssetRow = {
  id: string;
  current_version_id?: string | null;
  latest_version_number?: number | null;
  [key: string]: unknown;
};

// Parses a request body's `document_ids` selection. Returns null when it is
// missing, not an array, empty, over the cap, or carries duplicate/blank
// entries — the route answers 400 for every one of those cases.
export function parseAssetDocumentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const documentIds = [
    ...new Set(
      value.filter(
        (documentId: unknown): documentId is string =>
          typeof documentId === "string" && documentId.trim().length > 0,
      ),
    ),
  ];
  if (
    documentIds.length === 0 ||
    documentIds.length > MAX_WORKFLOW_ASSET_SOURCES ||
    documentIds.length !== value.length
  ) {
    return null;
  }
  return documentIds;
}

export async function listWorkflowAssets(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<{ ok: true; assets: WorkflowAssetRow[] } | WorkflowAssetFailure> {
  const { workflowId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access) return { ok: false, kind: "workflow_not_found" };
  if (assetsUnsupported(access)) {
    return { ok: false, kind: "tabular_unsupported" };
  }

  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, kind: "db_error", error };
  const assets = (data ?? []) as WorkflowAssetRow[];
  await attachLatestVersionNumbers(db, assets);
  await attachActiveVersionPaths(db, assets);
  return { ok: true, assets };
}

export async function copyDocumentsToWorkflowAssets(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    documentIds: string[];
  },
): Promise<{ ok: true; assets: unknown[] } | WorkflowAssetFailure> {
  const { workflowId, userId, userEmail, documentIds } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access || !access.allowEdit) {
    return { ok: false, kind: "not_editable" };
  }
  if (assetsUnsupported(access)) {
    return { ok: false, kind: "tabular_unsupported" };
  }

  const { data: sourceDocuments, error: documentsError } = await db
    .from("documents")
    .select("id, user_id, project_id, workflow_id, current_version_id")
    .in("id", documentIds);
  if (documentsError) {
    return { ok: false, kind: "db_error", error: documentsError };
  }
  if (!sourceDocuments || sourceDocuments.length !== documentIds.length) {
    return { ok: false, kind: "documents_not_found" };
  }

  // Edit rights on the workflow never stand in for access to the files being
  // copied: each source document is checked on its own.
  const accessResults = await Promise.all(
    sourceDocuments.map((document) =>
      ensureDocAccess(document, userId, userEmail, db),
    ),
  );
  if (accessResults.some((result) => !result.ok)) {
    return { ok: false, kind: "documents_not_found" };
  }

  const versionIds = sourceDocuments.flatMap((document) =>
    document.current_version_id ? [document.current_version_id] : [],
  );
  if (versionIds.length !== documentIds.length) {
    return { ok: false, kind: "documents_not_ready" };
  }
  const { data: sourceVersions, error: versionsError } = await db
    .from("document_versions")
    .select(
      "id, document_id, storage_path, pdf_storage_path, filename, file_type, size_bytes, page_count, content_sha256",
    )
    .in("id", versionIds)
    .is("deleted_at", null);
  if (versionsError) {
    return { ok: false, kind: "db_error", error: versionsError };
  }
  if (
    !sourceVersions ||
    sourceVersions.length !== documentIds.length ||
    sourceVersions.some((version) => !version.storage_path || !version.filename)
  ) {
    return { ok: false, kind: "documents_not_ready" };
  }

  const sourceDocumentById = new Map(
    sourceDocuments.map((document) => [document.id, document]),
  );
  const sourceVersionById = new Map(
    sourceVersions.map((version) => [version.id, version]),
  );
  if (
    sourceDocuments.some(
      (document) =>
        sourceVersionById.get(document.current_version_id)?.document_id !==
        document.id,
    )
  ) {
    return { ok: false, kind: "documents_not_ready" };
  }
  const plans = documentIds.map((sourceDocumentId) => {
    const sourceDocument = sourceDocumentById.get(sourceDocumentId)!;
    const sourceVersion = sourceVersionById.get(
      sourceDocument.current_version_id,
    )!;
    const documentId = randomUUID();
    const versionId = randomUUID();
    const sourcePath = storageKey(userId, documentId, sourceVersion.filename);
    const pdfPath = sourceVersion.pdf_storage_path
      ? sourceVersion.pdf_storage_path === sourceVersion.storage_path
        ? sourcePath
        : convertedPdfKey(userId, documentId)
      : null;
    return {
      documentId,
      versionId,
      sourceVersion,
      sourcePath,
      pdfPath,
    };
  });
  const copiedPaths = new Set<string>();

  try {
    for (const plan of plans) {
      copiedPaths.add(plan.sourcePath);
      await copyFile(plan.sourceVersion.storage_path, plan.sourcePath);
      if (
        plan.pdfPath &&
        plan.pdfPath !== plan.sourcePath &&
        plan.sourceVersion.pdf_storage_path
      ) {
        copiedPaths.add(plan.pdfPath);
        await copyFile(plan.sourceVersion.pdf_storage_path, plan.pdfPath);
      }
    }

    const { error: insertDocumentsError } = await db.from("documents").insert(
      plans.map((plan) => ({
        id: plan.documentId,
        project_id: null,
        user_id: userId,
        status: "ready",
        folder_id: null,
        library_kind: "workflow_asset",
        library_folder_id: null,
        workflow_id: workflowId,
      })),
    );
    if (insertDocumentsError) throw insertDocumentsError;

    const { error: insertVersionsError } = await db
      .from("document_versions")
      .insert(
        plans.map((plan) => ({
          id: plan.versionId,
          document_id: plan.documentId,
          storage_path: plan.sourcePath,
          pdf_storage_path: plan.pdfPath,
          source: "upload",
          version_number: 1,
          filename: plan.sourceVersion.filename,
          file_type: plan.sourceVersion.file_type,
          size_bytes: plan.sourceVersion.size_bytes,
          page_count: plan.sourceVersion.page_count,
          content_sha256: plan.sourceVersion.content_sha256,
        })),
      );
    if (insertVersionsError) throw insertVersionsError;

    for (const plan of plans) {
      const { error: updateError } = await db
        .from("documents")
        .update({
          current_version_id: plan.versionId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", plan.documentId);
      if (updateError) throw updateError;
    }

    const createdIds = plans.map((plan) => plan.documentId);
    const { data: createdDocuments, error: createdDocumentsError } = await db
      .from("documents")
      .select("*")
      .in("id", createdIds);
    if (
      createdDocumentsError ||
      !createdDocuments ||
      createdDocuments.length !== createdIds.length
    ) {
      throw (
        createdDocumentsError ??
        new Error("Workflow asset copy returned no documents")
      );
    }
    await attachLatestVersionNumbers(db, createdDocuments);
    await attachActiveVersionPaths(db, createdDocuments);
    const createdById = new Map(
      createdDocuments.map((document) => [document.id, document]),
    );
    return { ok: true, assets: createdIds.map((id) => createdById.get(id)) };
  } catch (error) {
    // Roll the whole copy back durably: orphaned rows go first, then the
    // objects already copied are handed to the storage.cleanup queue.
    const createdIds = plans.map((plan) => plan.documentId);
    await db.from("documents").delete().in("id", createdIds);
    await enqueueStorageCleanup(db, [...copiedPaths]);
    return { ok: false, kind: "db_error", error };
  }
}

export async function deleteWorkflowAsset(
  db: Db,
  params: {
    workflowId: string;
    assetId: string;
    userId: string;
    userEmail: string | undefined;
  },
): Promise<{ ok: true } | WorkflowAssetFailure> {
  const { workflowId, assetId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access || !access.allowEdit) {
    return { ok: false, kind: "not_editable" };
  }
  if (assetsUnsupported(access)) {
    return { ok: false, kind: "tabular_unsupported" };
  }
  const { data: asset } = await db
    .from("documents")
    .select("id")
    .eq("id", assetId)
    .eq("workflow_id", workflowId)
    .maybeSingle();
  if (!asset) return { ok: false, kind: "asset_not_found" };
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", asset.id);
  if (versionsError) {
    return { ok: false, kind: "db_error", error: versionsError };
  }
  const { error } = await db
    .from("documents")
    .delete()
    .eq("id", asset.id)
    .eq("workflow_id", workflowId);
  if (error) return { ok: false, kind: "db_error", error };
  // Row first, file second (durable): a failed row delete leaves the file
  // referenced and intact; a crash after it still cleans the file up.
  await enqueueStorageCleanup(
    db,
    (versions ?? []).flatMap((version) =>
      [version.storage_path, version.pdf_storage_path].filter(
        (path): path is string => !!path,
      ),
    ),
  );
  return { ok: true };
}

export type ListSharesResult =
  | { ok: true; shares: unknown[] }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export type ListWorkflowPeopleResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

// GET /workflows/:workflowId/people — the access roster any viewer of the
// workflow may read. Organization workflows answer from the org roster (with
// its overrides); personal ones answer from the direct-grant table.
export async function listWorkflowPeople(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<ListWorkflowPeopleResult> {
  const { workflowId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access) return { ok: false, kind: "not_found" };

  const orgId = (access.workflow as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    const listed = await listOrgAccessPeople(db, {
      kind: "workflow",
      resourceId: workflowId,
      orgId,
      creatorId: access.workflow.user_id,
    });
    if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
    const creator = listed.people.find(
      (person) => person.user_id === access.workflow.user_id,
    );
    return {
      ok: true,
      body: {
        scope: "organization",
        owner: creator
          ? {
              user_id: creator.user_id,
              email: creator.email,
              display_name: creator.display_name,
              role: "owner",
            }
          : null,
        members: listed.people.filter(
          (person) => person.user_id !== access.workflow.user_id,
        ),
      },
    };
  }

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("shared_with_email, role")
    .eq("workflow_id", workflowId);
  if (error) return { ok: false, kind: "db_error", error };
  const { userByEmail, userById } = await loadProfileUsersByEmail(db);
  const creator = access.workflow.user_id
    ? userById.get(access.workflow.user_id)
    : undefined;
  return {
    ok: true,
    body: {
      scope: "direct",
      owner: access.workflow.user_id
        ? {
            user_id: access.workflow.user_id,
            email: creator?.email ?? null,
            display_name: creator?.display_name ?? null,
            role: "owner",
          }
        : null,
      members: (
        (shares ?? []) as {
          shared_with_email: string;
          role: ProjectRole;
        }[]
      ).map((share) => ({
        email: share.shared_with_email,
        display_name:
          userByEmail.get(share.shared_with_email)?.display_name ?? null,
        role: share.role,
      })),
    },
  };
}

export async function listWorkflowShares(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<ListSharesResult> {
  const { workflowId, userId, userEmail } = params;

  const wf = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!wf) return { ok: false, kind: "not_found" };

  const orgId = (wf as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    const listed = await listOrgAccessPeople(db, {
      kind: "workflow",
      resourceId: workflowId,
      orgId,
      creatorId: wf.user_id,
    });
    if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
    return {
      ok: true,
      shares: listed.people
        .filter(
          (person) => person.user_id !== wf.user_id && person.has_override,
        )
        .map((person) => ({
          id: person.user_id,
          user_id: person.user_id,
          shared_with_email: person.email,
          display_name: person.display_name,
          role: person.role,
        })),
    };
  }

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("id, shared_with_email, role, created_at")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, kind: "db_error", error };

  return { ok: true, shares: shares ?? [] };
}

export async function deleteWorkflowShare(
  db: Db,
  params: {
    workflowId: string;
    shareId: string;
    userId: string;
    userEmail: string | undefined;
  },
): Promise<
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown }
> {
  const { workflowId, shareId, userId, userEmail } = params;

  const wf = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!wf) return { ok: false, kind: "not_found" };

  const orgId = (wf as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    const result = await deleteOrgAccessOverride(db, {
      kind: "workflow",
      resourceId: workflowId,
      userId: shareId,
    });
    if (!result.ok) return { ok: false, kind: "db_error", error: result.detail };
  } else {
    await db
      .from("workflow_shares")
      .delete()
      .eq("id", shareId)
      .eq("workflow_id", workflowId);
  }
  return { ok: true };
}

export type ShareWorkflowResult =
  | { ok: true }
  | {
      ok: false;
      kind: "validation" | "self_share" | "missing_user";
      detail: string;
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function shareWorkflow(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    emails: string[];
    role: unknown;
  },
): Promise<ShareWorkflowResult> {
  const { workflowId, userId, userEmail, emails, role } = params;

  const normalizedEmails = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (normalizedEmails.length === 0) {
    return { ok: false, kind: "validation", detail: "emails is required" };
  }
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  if (normalizedUserEmail && normalizedEmails.includes(normalizedUserEmail)) {
    return {
      ok: false,
      kind: "self_share",
      detail: "You cannot share a workflow with yourself.",
    };
  }

  // Any effective Owner may manage access. Personal grants are stored by
  // normalized email and may only target an existing user; organization
  // overrides require a current organization member.
  const wf = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!wf) return { ok: false, kind: "not_found" };

  const orgId = (wf as { org_id?: string | null }).org_id ?? null;
  if (orgId) {
    if (!isOrgAssignableRole(role))
      return {
        ok: false,
        kind: "validation",
        detail: "role must be owner, editor, viewer or deny",
      };
    for (const email of normalizedEmails) {
      const target = await findOrgMemberByEmail(db, orgId, email);
      if (!target.ok) {
        if (target.kind === "not_found")
          return { ok: false, kind: "validation", detail: target.detail };
        return { ok: false, kind: "db_error", error: target.detail };
      }
      if (target.member.userId === wf.user_id)
        return {
          ok: false,
          kind: "validation",
          detail: "The creator is always an owner",
        };
      if (target.member.orgRole === "admin")
        return {
          ok: false,
          kind: "validation",
          detail: "Organization admins always have owner access",
        };
      const result = await setOrgAccessOverride(db, {
        kind: "workflow",
        resourceId: workflowId,
        orgId,
        userId: target.member.userId,
        role,
        assignedBy: userId,
      });
      if (!result.ok)
        return { ok: false, kind: "db_error", error: result.detail };
    }
    return { ok: true };
  }

  if (role !== "owner" && role !== "editor" && role !== "viewer")
    return {
      ok: false,
      kind: "validation",
      detail: "role must be owner, editor or viewer",
    };

  let missingEmails: string[];
  try {
    missingEmails = await findMissingUserEmails(db, normalizedEmails);
  } catch (error) {
    return { ok: false, kind: "db_error", error };
  }
  if (missingEmails.length > 0)
    return {
      ok: false,
      kind: "missing_user",
      detail: `${missingEmails[0]} does not belong to a Mike user.`,
    };

  const rows = normalizedEmails.map((email: string) => ({
    workflow_id: workflowId,
    shared_by_user_id: userId,
    shared_with_email: email,
    role,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  const { error } = await db
    .from("workflow_shares")
    .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
  if (error) return { ok: false, kind: "db_error", error };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Add-on catalog (`mike_workflows` rows with distribution = "addon").
// The implementation lives in workflows.addons.ts; this facade re-exports it
// by name so the rest of the backend keeps one entry point per module.
export {
  listWorkflowAddons,
  loadWorkflowAddonAssetDisplay,
  getWorkflowAddon,
  importWorkflowAddon,
} from "./workflows.addons";
export type {
  WorkflowAddonSummary,
  ImportedWorkflow,
  WorkflowAddonImportFailure,
  ImportWorkflowAddonResult,
} from "./workflows.addons";
