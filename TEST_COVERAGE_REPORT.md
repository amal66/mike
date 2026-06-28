# Mike — Test Coverage Report
_Generated 2026-06-28_

---

## 1. Current State

| Layer | Framework | Files | Test Cases |
|---|---|---|---|
| E2E (browser) | Playwright | 2 | 3 |
| API unit/integration | Vitest | 17 | ~134 |
| Python SDK | pytest | 1 | 13 |
| packages/core | — | 0 | 0 |
| packages/api-client | — | 0 | 0 |
| packages/sdk-js | — | 0 | 0 |
| **Total** | | **20** | **~150** |

**Overall coverage estimate: ~15% of testable surface area.**  
The existing unit tests are concentrated in `apps/api/src/lib/` utility helpers. There are zero controller/route tests, zero package tests, and only 3 E2E scenarios covering a fraction of the product's flows.

---

## 2. What Already Has Tests

### API unit tests (Vitest — `apps/api/src/lib/__tests__/`)
| File | What's covered |
|---|---|
| `access.test.ts` | `checkProjectAccess`, `ensureDocAccess`, `filterAccessibleDocumentIds` |
| `http.test.ts` | `sendError`, `parseBody` |
| `downloadTokens.test.ts` | Sign/verify round-trip, tampering, expiry, legacy compat |
| `upload.test.ts` | Magic-byte validation for PDF/DOCX/DOC |
| `storage.test.ts` | Key generation, filename sanitization, RFC 5987 encoding |
| `chatTools.test.ts` | `generateSpotlightNonce`, `resolveDoc`, `resolveDocLabel` |
| `credits.test.ts` | Credit limit enforcement, reset date rollover, DB fail-open |
| `userApiKeys.test.ts` | `normalizeApiKeyProvider`, `hasEnvApiKey` |
| `llm/retryCircuit.test.ts` | Circuit breaker opens on 503s, skips 401s |
| `llm/models.test.ts` | `providerForModel`, `resolveModel` fallback chain |
| `llm/baseUrl.test.ts` | URL validation, protocol enforcement |
| `llm/vertexAI.test.ts` | Vertex AI provider registration and model matching |
| `llm/registry.test.ts` | Provider register/retrieve, `findProviderForModel` |
| `storage/gcs.test.ts` | GCS adapter upload/download/sign/ready |
| `integration/health.test.ts` | GET /health, GET /ready, requireAuth 401, 404 |
| `integration/access.supabase.test.ts` | Real Supabase DB access control (skipped if no env vars) |

### E2E (`e2e/`)
1. Authenticated user lands on `/assistant`
2. Create project → upload PDF → open assistant → send message
3. Unauthenticated `/assistant` redirects to `/login`

---

## 3. Missing: Controller / Route Tests

**Zero route-level tests exist.** Every module needs a controller test suite that mocks the database and services, tests request validation, and asserts response shapes. Below is the full route list annotated with what needs testing.

### 3.1 Health (`GET /health`, `GET /ready`)
_Partially covered by integration test. No mocked-DB fast unit version._

---

### 3.2 Chat module (`/chat`)
| Route | Test Cases Needed |
|---|---|
| `GET /` | Returns paginated chat list; respects `limit` and `cursor`; 401 when no auth |
| `POST /create` | Creates chat row; optional `project_id` attached; 400 on bad body |
| `GET /:chatId` | Returns chat + messages; 404 on unknown id; 403 on other user's chat |
| `PATCH /:chatId` | Renames chat; 400 on empty title; 403 on wrong owner |
| `DELETE /:chatId` | Deletes chat; 404 on missing; 403 on wrong owner |
| `POST /:chatId/generate-title` | Generates title; handles missing messages gracefully |
| `POST /` (stream) | SSE response headers set; streaming begins; 400 on invalid body; rate-limit 429 |

---

### 3.3 Projects module (`/projects`)
| Route | Test Cases Needed |
|---|---|
| `GET /` | Returns owned + shared projects with counts; empty list when none |
| `POST /` | Creates project; trims whitespace; rejects self-share; 400 on missing name |
| `GET /:projectId` | Returns project with docs/folders; 404 unknown; 403 no access |
| `GET /:projectId/people` | Resolves display names for owner + shared_with |
| `PATCH /:projectId` | Updates name/cm_number/shared_with; owner only |
| `DELETE /:projectId` | Deletes project; 403 if not owner |
| `GET /:projectId/documents` | Lists docs in project; folders structure |
| `POST /:projectId/documents/:documentId` | Assigns/copies existing doc; validates doc ownership |
| `PATCH /:projectId/documents/:documentId` | Renames doc |
| `POST /:projectId/documents` | Uploads file; validates magic bytes; 415 on wrong type; size limit |
| `GET /:projectId/chats` | Lists chats visible to current user |
| `POST /:projectId/folders` | Creates folder; rejects duplicate names |
| `PATCH /:projectId/folders/:folderId` | Renames folder; cycle-detection on reparent |
| `DELETE /:projectId/folders/:folderId` | Deletes folder; promotes children to root |
| `PATCH /:projectId/documents/:documentId/folder` | Moves doc; validates folder belongs to project |

---

### 3.4 Project Chat module (`/projects/:projectId/chat`)
| Route | Test Cases Needed |
|---|---|
| `POST /` (stream) | SSE headers; includes project doc context; 403 if no project access; 400 bad body |

---

### 3.5 Documents module (`/single-documents`)
| Route | Test Cases Needed |
|---|---|
| `GET /` | Lists standalone docs for user; excludes project-attached docs |
| `POST /` | Uploads doc; validates PDF/DOCX magic bytes; returns doc row |
| `DELETE /:documentId` | Deletes doc + storage; 404 unknown; 403 wrong owner |
| `GET /:documentId/display` | Serves PDF bytes; DOCX→PDF conversion for docx; 404 unknown |
| `POST /download-zip` | Zips up to 50 docs; 400 over limit; 403 for inaccessible doc IDs |
| `GET /:documentId/url` | Returns signed URL; verifies access |
| `GET /:documentId/docx` | Returns raw DOCX bytes; 404 if non-docx |
| `GET /:documentId/versions` | Lists versions ordered by version_number |
| `POST /:documentId/versions` | Uploads new version; becomes current_version_id |
| `PATCH /:documentId/versions/:versionId` | Updates display_name |
| `GET /:documentId/tracked-change-ids` | Extracts DOCX tracked-change IDs |
| `POST /:documentId/edits/:editId/accept` | Applies and persists edit; 404 edit not found |
| `POST /:documentId/edits/:editId/reject` | Removes pending edit |

---

### 3.6 Tabular Review module (`/tabular-review`)
| Route | Test Cases Needed |
|---|---|
| `GET /` | Lists reviews owned + shared; optional `?project_id=` filter |
| `POST /` | Creates review; validates columns_config shape; optional document_ids |
| `POST /prompt` | Generates extraction prompt via LLM; 400 on bad body |
| `GET /:reviewId` | Returns review + cells + documents; 403 no access |
| `GET /:reviewId/people` | Resolves member display names |
| `PATCH /:reviewId` | Updates metadata; validates shared_with; syncs document_ids |
| `DELETE /:reviewId` | Deletes review + cells; owner only |
| `POST /:reviewId/clear-cells` | Resets all cells to pending |
| `POST /:reviewId/regenerate-cell` | Regenerates single cell; 404 unknown cell |
| `POST /:reviewId/generate` (stream) | SSE generate; sync fallback when no Redis |
| `GET /:reviewId/chats` | Lists chats for this review |
| `DELETE /:reviewId/chats/:chatId` | Deletes review chat; owner only |
| `GET /:reviewId/chats/:chatId/messages` | Returns messages |
| `POST /:reviewId/chat` (stream) | Agentic SSE chat in review context |

---

### 3.7 Workflows module (`/workflows`)
| Route | Test Cases Needed |
|---|---|
| `GET /` | Lists owned + shared; optional `?type=` filter |
| `POST /` | Creates workflow; validates type enum |
| `PUT /:workflowId` / `PATCH /:workflowId` | Updates; computes `shared_by_name` |
| `DELETE /:workflowId` | Owner only; rejects system workflows |
| `GET /hidden` | Lists hidden workflow IDs for user |
| `POST /hidden` | Hides a workflow (upsert) |
| `DELETE /hidden/:workflowId` | Unhides |
| `GET /:workflowId` | Returns with `allow_edit`, `is_owner`, `shared_by_name` |
| `GET /:workflowId/shares` | Lists shares; owner only |
| `DELETE /:workflowId/shares/:shareId` | Removes share; owner only |
| `POST /:workflowId/share` | Shares with email(s); validates `allow_edit` |
| `GET /:workflowId/export` | Returns `.mikeworkflow.json`; owner only |
| `POST /import` | Imports from JSON body; generates fresh ID |

---

### 3.8 User module (`/user`)
| Route | Test Cases Needed |
|---|---|
| `POST /profile` | Creates/upserts profile row; idempotent |
| `GET /profile` | Returns profile with credits and tier; auto-repairs missing row |
| `PATCH /profile` | Updates displayName, organisation, tabularModel |
| `GET /api-keys` | Returns key status per provider (configured/not) |
| `PUT /api-keys/:provider` | Encrypts and stores key; validates provider enum; clears on empty |
| `DELETE /account` | Deletes Supabase auth user; requires valid token |

---

### 3.9 Downloads module (`/download`)
| Route | Test Cases Needed |
|---|---|
| `GET /:token` | Verifies HMAC token; checks access; streams correct content-type; 403 tampered token |

---

## 4. Missing: Unit Tests

### 4.1 `apps/api/src/lib/` — NOT yet tested

| File | Priority | What to test |
|---|---|---|
| `docxTrackedChanges.ts` | **HIGH** | `applyTrackedEdits` XML manipulation, edge cases (backslash paths, pre-existing changes), `resolveTrackedChange` find/replace logic |
| `convert.ts` | **HIGH** | `normalizeDocxZipPaths` (backslash → forward slash normalization), `convertedPdfKey` path construction |
| `chatContext.ts` | **HIGH** | `buildMessages` message format, `buildDocContext` citation fencing, nonce generation isolation, workflow injection |
| `auth.ts` (middleware) | **HIGH** | `requireAuth` valid Bearer → userId/userEmail attached; missing header → 401; invalid JWT → 401 |
| `asyncErrors.ts` | **MEDIUM** | Async handler wrapping, unhandled rejection routed to Express error middleware, no double-wrap |
| `documentVersions.ts` | **MEDIUM** | `loadActiveVersion` (explicit vs current_version_id), `attachActiveVersionPaths`, `attachLatestVersionNumbers` aggregation |
| `userSettings.ts` | **MEDIUM** | `resolveTitleModel` fallback chain, `getUserModelSettings` key precedence (env > user-stored) |
| `llm/tools.ts` | **MEDIUM** | `toClaudeTools` / `toGeminiTools` schema mapping, empty-properties handling for Gemini |
| `tabularProcessor.ts` | **MEDIUM** | `formatPromptSuffix`, `queryTabularAllColumns` column dispatch logic |
| `env.ts` | **LOW** | Zod schema: required fields, coercions, defaults |

### 4.2 `packages/` — zero tests anywhere

| File | Priority | What to test |
|---|---|---|
| `api-client/src/index.ts` | **HIGH** | Auth header injection, error parsing (status/code), 204 handling, all CRUD operations with mocked fetch |
| `core/src/storagePaths.ts` | **HIGH** | Filename sanitization (control chars, slashes), RFC 5987 encoding, storage key construction variants |
| `core/src/apiKeyProviders.ts` | **HIGH** | `isApiKeyProvider`, `normalizeApiKeyProvider`, `envApiKey` fallbacks (ANTHROPIC_API_KEY → CLAUDE_API_KEY) |
| `sdk-js/src/index.ts` | **MEDIUM** | Constructor options merge, method forwarding to api-client |

### 4.3 `apps/web/src/` — no unit tests at all

| File | Priority | What to test |
|---|---|---|
| `lib/modelAvailability.ts` | **HIGH** | Model→provider mapping, `isModelAvailable` against ApiKeyState, provider labels |
| `hooks/useAssistantChat.ts` | **HIGH** | Message accumulation, streaming drip, abort signal, new chat ID assignment |
| `hooks/useFetchDocxBytes.ts` | **MEDIUM** | Cache key construction, concurrent dedup (inFlight map), cache invalidation |
| `hooks/useSelectedModel.ts` | **MEDIUM** | localStorage read/write, validation against allowed IDs, SSR safety |
| `hooks/useDocumentVersions.ts` | **LOW** | Cancellation on unmount, refresh trigger, error handling |

---

## 5. Missing: E2E / Integration Tests

~7% of user-facing flows are covered. The table below lists uncovered flows by priority.

### Priority 1 — Critical (do first)

| Flow | Route | What to test |
|---|---|---|
| Login with wrong password | `/login` | Error message appears; user stays on login page |
| Login with valid credentials | `/login` | Redirect to `/assistant`; session persists on reload |
| Sign up new user | `/signup` | Form validation, account creation, redirect |
| Project assistant chat (with citations) | `/projects/[id]/assistant/chat/[chatId]` | Full chat with document context; citation links expand |
| API key management | `/account/models` | Add/update/remove key per provider; model toggle reflects availability |
| Tabular review creation and generation | `/tabular-reviews` | Create review, add documents, generate cells, verify SSE streaming |
| Tabular review cell editing | `/tabular-reviews/[id]` | Edit cell inline by type (text/number/list/enum) |
| Workflow editor | `/workflows/[id]` | Edit prompt, add/remove columns, auto-save; built-in = read-only |

### Priority 2 — High

| Flow | Route | What to test |
|---|---|---|
| Document version upload | `/projects/[id]` (Documents tab) | Upload new version; version list updates; display switches |
| Rename / delete project | `/projects` | Inline rename; delete confirmation; list updates |
| Folder creation + move doc | `/projects/[id]` | Create folder; drag/click doc into folder; hierarchy visible |
| Logout flow | Sidebar | User clicks logout; redirected to `/login`; session cleared |
| Account deletion | `/account` | Confirmation modal; deletion completes; redirected to `/login` |
| Rate-limit / credits exhausted | `/assistant` or any chat | Modal appears when credits gone; no silent failure |
| Chat rename and delete | Sidebar / `/assistant/chat/[id]` | Rename from sidebar; delete; removed from history |
| Unauthenticated access to other protected routes | `/projects`, `/tabular-reviews`, `/workflows`, `/account` | All redirect to `/login` |

### Priority 3 — Medium

| Flow | Route | What to test |
|---|---|---|
| Support form submission | `/support` | Select type, fill form, submit; success state |
| Workflow import / export | `/workflows` | Export `.mikeworkflow.json`; re-import as new workflow |
| Bulk delete projects | `/projects` | Select multiple; Actions → Delete; list updates |
| Tabular review chat panel | `/tabular-reviews/[id]` | Open chat for a row; message streaming; history persists |
| DOCX tracked-change accept/reject | `/projects/[id]` (Documents tab) | Accept a tracked change; doc updates |
| File upload errors | Any upload | Over-size file rejected; wrong type rejected; error shown |
| Cold-load chat history | `/assistant/chat/[id]` | Direct navigation to existing chat; history renders correctly |

---

## 6. Prioritised Action Plan

### Phase 1 — Controller tests (highest ROI)
Add Vitest supertest tests that mount the Express app with a mocked Supabase client. Cover every route's happy path, auth rejection (401/403), and validation rejection (400).

**Start with:** `chat`, `projects`, `user` (most commonly used).

Estimated: ~200 test cases across ~40 files.

### Phase 2 — Missing unit tests
Fill gaps in lib utilities that have no coverage yet:
1. `docxTrackedChanges.ts` — XML edge cases (regression risk)
2. `chatContext.ts` — prompt injection security
3. `auth.ts` middleware
4. `packages/api-client` — full API surface
5. `packages/core` — storage paths + provider helpers

Estimated: ~80 additional test cases.

### Phase 3 — E2E expansion
Add Playwright tests for the 8 Priority-1 flows listed above, then Priority-2.

Estimated: ~15–20 additional spec tests.

### Phase 4 — Frontend unit tests
Add React Testing Library tests for hooks (`useAssistantChat`, `useFetchDocxBytes`) and pure utilities (`modelAvailability.ts`).

Estimated: ~30 test cases.

---

## 7. Test Infrastructure Notes

- **Vitest** is already configured in `apps/api` — controller tests can be added immediately using supertest + vi.mock for Supabase.
- **No test runner** configured for `packages/*` — add Vitest to `packages/api-client`, `packages/core`, `packages/sdk-js`.
- **No component test runner** for `apps/web` — add Vitest + React Testing Library for hook/utility tests; Playwright already handles E2E.
- **Supabase integration tests** require `SUPABASE_TEST_URL` + `SUPABASE_TEST_SERVICE_ROLE_KEY` env vars and are skipped otherwise — document this in CI setup.
