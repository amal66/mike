# Combined Google integrations verification

PR: [#434](https://github.com/open-legal-products/mike/pull/434). The former
Gmail/Calendar PR #522 is closed as superseded; all implementation is in #434.

Implementation tested: `0824e7f43f321c23d427374116ada1652d4739b1`, rebased onto
`main` at `4ad85e463ea769809c9e177fbe7a84548c71d546`.

**Status: automated regression verification passed; fresh live Google acceptance
is incomplete. This report is not a merge-readiness sign-off.**

## Environment and evidence boundaries

- Production Next.js web server on localhost:3000, Express on localhost:3001.
- Local Supabase and disposable S3-compatible storage; synthetic documents only.
- Live model tests used the model key saved in the disposable Mike test user's
  profile. No credential is included in this report or the screenshots.
- Requested Google project: `soy-oarlock-503613-m7`, OAuth client MikeOSS.
  Organization-owned project; OAuth audience is **External / Testing**.
  This is not evidence of an Internal Workspace audience or administrator policy.
- The old `mikeamal` connections were removed before this run. The
  [September 22 report](google-workspace-live-2026-09-22.md) covers that older
  project and service-driven/seeded UI tests, not a model-driven Google workflow.

## Automated results

| Check | Result |
| --- | --- |
| Backend unit/integration suite | 2,433 passed; 47 local-stack tests skipped in this command |
| Local Supabase stack suite | All 47 of those tests passed against the local stack |
| Frontend unit/component suite | 1,635 passed |
| Full web Playwright suite | 33 passed, zero skipped, zero failed |
| Live model subset of web suite | Chat rename/delete, project chat, PDF upload/question all ran with real model responses |
| Word add-in browser suite | 346 passed across Chromium and WebKit |
| Disposable Google Workspace database checks | Migration replay, grants/RLS, ownership, expiry, replacement, and concurrent approval claims passed |
| Disconnect regression tests | 69 Drive lifecycle/Workspace tests passed; Drive disconnect makes no project-wide revocation request |
| Backend and frontend production builds | Passed (Next webpack build) |
| Word production build | Passed using documented example deployment URLs; three existing webpack warnings |
| Backend test/contracts and frontend type checks | Passed |
| Frontend lint | Zero errors; 32 existing warnings |
| Diff whitespace check | Passed |

Frontend and Word suites were run on the same integration source before the final
backend-only disconnect fix. The complete backend suite and build were repeated
after that fix. The Google connector browser tests use mocked Google endpoints;
the four live model tests do not exercise Google tool selection. Neither is a
substitute for the outstanding real Google acceptance below.

The browser accessibility scans found no critical violations. They report existing
serious issues (including color contrast and focusable scrolling) without failing
the suite; this is not a claim that the whole app is accessibility-clean.

## Fixes found during this run

- Corrected stale model-picker selectors, missing project-helper imports, the
  post-submit chat-route expectation, and obsolete sidebar selection classes.
  Model-dependent tests now run instead of being hidden behind a missing-key skip.
- Scoped Drive browser controls so connected Gmail/Calendar Disconnect buttons
  cannot produce an ambiguous selector.
- Corrected local storage configuration and synced the pinned workflow catalog so
  upload and workflow tests exercise a complete local deployment.
- Made Drive disconnect local to that service. Google token revocation removes
  the project's grants and could break Gmail/Calendar connections using the same
  project. All three services now remove their own local credentials; users can
  revoke the whole app in Google Account settings.
- Removed CI branch filters added solely for the former child PR.
- Fixed a CI-only startup race in the disposable database test: wait for the
  final TCP listener instead of PostgreSQL's temporary initialization socket.
  A fresh-container run passed after the fix; application code was unchanged.

## Fresh Google project checks

| Check | Observed result |
| --- | --- |
| Drive, Gmail, Calendar REST APIs | Enabled in the requested project |
| OAuth client and backend configuration | Matching client configured locally; secrets remain ignored/uncommitted |
| Three localhost callbacks | Saved for Drive, Gmail, and Calendar via localhost:3000/api |
| Test-user eligibility | Configured; fresh Drive OAuth passed the prior access-denied screen |
| Optional scopes | gmail.modify and calendar.events saved alongside the existing read scopes |
| Final Drive consent | Reached the read/download consent screen; grant not yet submitted |
| Gmail/Calendar consent and live provider operations | Pending |
| Actual Assistant Google tool selection and inline mutation approval | Pending |

The account consent request is awaiting user approval because it grants the local
Mike server ongoing access to Google account data. Configuring Cloud scopes and
test users is distinct from granting that access. The uncompleted Drive popup
timed out normally without creating a connection.

The current local UI shows all services disconnected with explicit opt-in controls:

![Opt-in service connections](google-integrations-2026-09-23/01-opt-in-connections.png)

A real Claude Sonnet 4.6 conversation also confirmed it had no Drive, Gmail, or
Calendar tools while disconnected and returned no invented Google results.
This was a normal Assistant submission, not a seeded message or mocked response.
It proves the disconnected negative case only; its generic setup prose is not
the authoritative operator guide.

![Actual Assistant response while disconnected](google-integrations-2026-09-23/02-disconnected-assistant.png)

## Remaining acceptance before sign-off

1. Grant read-only consent separately for Drive, Gmail, and Calendar through the
   requested project's client; confirm the selected account for each service.
2. Use a real Assistant conversation to search/read a synthetic Drive document,
   synthetic email/thread, and bounded calendar events. Verify the results in Google.
3. Grant the separate Gmail/Calendar write upgrades. In Assistant, create a draft
   and an event, reject a second proposal, and separately approve edit/delete or
   Trash actions. Verify exact content, no writes before approval, and one effect
   after approval. Capture sanitized inline-card and provider-state screenshots.
4. Exercise stale-event conflict, disconnect with pending approval, independent
   service disconnect, refresh/reconnect, and account replacement. Record which
   cases are live and which are covered only by automated fixtures.
5. Verify all required CI checks on the final pushed head and update this report
   and the PR description with the completed live evidence or explicit blockers.

See [the operator and manual acceptance guide](../google-workspace.md) for scope,
architecture, self-hosting, and step-by-step setup details. Each self-hosted
operator owns their Google project, credentials, audience, and any applicable
verification or Workspace administrator approval.
