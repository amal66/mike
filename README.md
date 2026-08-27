# Orgs / RBAC live round — 2026-08-26

Media-only orphan branch. No source code here; nothing on this branch is meant to be merged.

Recorded with a real browser (Playwright + Chromium) against a locally booted stack running the
current tips of the orgs/RBAC PR stack (#267 → #268 → #363), on an **upgrade-path database**:
`main`'s `schema.sql` plus migrations `20260828_01..05` applied on top, i.e. the path an existing
deployment would actually take rather than a fresh install.

Each flow ships as:

- `flow-NN-<slug>.gif` — 720px wide, 6 fps, palette-optimized (embedded in the PR bodies)
- `flow-NN-<slug>.mp4` — 960px h264 source recording
- `flow-NN-<slug>--NN-<label>.png` — labeled stills captured at the checkpoints inside the flow

## Flows

| # | Flow | What it shows |
|---|------|---------------|
| 01 | `flow-01-org-create-invite` | Creating an organization and inviting two people at chosen roles; pending invitations list with resend/cancel. |
| 02 | `flow-02-invitation-accept` | The invitee's inbox showing role and inviter, accepting, the org appearing, and the roster listing the new member. |
| 03 | `flow-03-last-admin-protection` | The sole admin cannot demote or remove themselves: own row shows a role badge rather than a picker, and the leave attempt is refused with a 409 surfaced in the UI; role stays admin. |
| 04 | `flow-04-project-sharing-roles` | Sharing a project with an org and with individual recipients at per-recipient roles, attaching a document, and creating the project. |
| 05 | `flow-05-member-inheritance` | A member with no explicit share sees the org-shared project through inheritance and can upload a document and create a folder. |
| 06 | `flow-06-viewer-read-only` | A viewer gets the project read-only: write affordances are withheld, and the denial names an admin to contact. |
| 07 | `flow-07-outsider-denied` | A non-member sees the project in none of the tabs, and a direct URL is denied without leaking project details. |
| 08 | `flow-08-chat-parity-list-detail` | An admin streams a chat in a shared project; a viewer sees it listed and can read it, with the composer read-only. |
| 09 | `flow-09-admin-chat-delete` | An admin deletes a chat they did not author; the same delete is refused for a viewer and the refusal is surfaced. |
| 10 | `flow-10-review-gating` | Tabular review gating on the unified member-tier details gate: a member can create a review and edit its details, a viewer is refused. Re-recorded after the fix round. |
