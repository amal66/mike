# Mike Word Add-in

An Office.js task pane add-in that brings the Mike legal AI platform directly into Microsoft Word. From the task pane you can chat with an AI about the open document (with optional full-document context), apply AI suggestions as tracked-change redlines, run one-click actions (improve writing, proofread, anonymise, draft clause), execute saved Mike workflows against the document, and browse or upload to Mike projects — all without leaving Word.

---

## Prerequisites

- Node.js 18+
- Microsoft Word desktop (macOS or Windows) **or** Word on the web — sideloading steps differ; see below
- Mike backend running locally — run `scripts/setup-local.sh` from the repo root first (starts Supabase and creates the `mike` storage bucket)

---

## Setup

1. **Install dependencies**

   ```bash
   cd apps/word-addin && npm install
   ```

2. **Set environment variables**

   The webpack build reads these from `process.env` at compile time. Create a file called `.env.development` in `apps/word-addin/`:

   ```bash
   # apps/word-addin/.env.development
   REACT_APP_SUPABASE_URL=http://127.0.0.1:54321
   REACT_APP_SUPABASE_ANON_KEY=<paste your anon key here>
   REACT_APP_API_BASE_URL=http://localhost:3001
   ```

   - `REACT_APP_SUPABASE_URL` — local Supabase instance; the value above is correct if you used `setup-local.sh`
   - `REACT_APP_SUPABASE_ANON_KEY` — find this with `supabase status` (look for `anon key`)
   - `REACT_APP_API_BASE_URL` — Mike API; default is `http://localhost:3001`

   Because this is a custom webpack build (not Create React App), the `.env.development` file is **not** read automatically. Source it in your shell before running npm commands:

   ```bash
   set -a && source .env.development && set +a
   ```

   Or prefix each command: `env $(cat .env.development | xargs) npm start`

3. **Trust the dev SSL certificate (macOS — one time only)**

   The dev server runs on `https://localhost:3000` with a self-signed certificate. Word refuses to load add-ins over untrusted HTTPS. Install the trusted cert once:

   ```bash
   npx office-addin-dev-certs install
   ```

   Restart Word after installing.

4. **Start the Mike API**

   From the repo root:

   ```bash
   npm run dev:api
   ```

5. **Start the add-in and sideload into Word**

   ```bash
   npm start
   ```

   This runs `office-addin-debugging start manifest.xml`, which starts the webpack dev server on `https://localhost:3000` **and** automatically opens Word with the add-in sideloaded. The task pane appears under **Home → Mike Legal AI → Open Mike**.

---

## Sideloading manually (if `npm start` does not auto-load)

### Word desktop — macOS

```bash
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

Restart Word, then: **Insert → Add-ins → My Add-ins → Mike**

### Word on the web

**Insert → Add-ins → Upload My Add-in** → select `manifest.xml`

> Note: Word on the web does not support tracked changes via the Word JavaScript API (`WordApi 1.4`). The "Apply as tracked change" buttons require Word desktop.

---

## Features

### Chat tab

Ask any question about the open document. Toggle **Use document as context** to send the full document text to the AI with each message. Responses stream in real time. On any AI response you can:

- **Insert at cursor** — pastes the response text at the current cursor position
- **Apply as tracked change** — inserts the response as a tracked-change revision (Word desktop only; requires WordApi 1.4)

### Actions tab

One-click AI operations, each streaming their result into a result box:

| Action | What it does |
|---|---|
| **Improve Writing** | Rewrites the currently **selected text** for clarity and professionalism. Result can be applied as a tracked change (replaces the original selection) or inserted at cursor. Select some text first — the button does nothing if the selection is empty. |
| **Proofread** | Reviews the **entire document** for grammar, typos, punctuation, and stylistic issues. Lists each problem with the original text and a suggested correction. Result is read-only (review and copy manually). |
| **Anonymise** | Scans the **entire document** for PII (names, addresses, phone numbers, dates of birth, IDs, etc.) and produces a numbered list of occurrences with proposed anonymised replacements. Result is read-only. |
| **Draft Clause** | Enter a description of the clause you need (e.g. "limitation of liability for SaaS product"), then click **Draft clause**. The result can be inserted at cursor or applied as a tracked change. |

### Workflows tab

Select a saved Mike workflow from the dropdown and click **Run workflow on document**. The workflow's instruction is sent as a system prompt with the full document text as the user message. Results stream in and can be inserted at cursor.

### Projects tab

Browse Mike projects you have access to. Selecting a project shows all documents currently in it. Click **Upload current document to project** to export the open Word document as a `.docx` file and upload it to the selected project via the Mike API.

---

## Signing in

Enter the same email and password you use for the Mike web app. The add-in authenticates directly against the local Supabase instance (`/auth/v1/token`) and stores the access token in `OfficeRuntime.storage` (persists across task pane reloads). Click **Sign out** in the header to clear the token.

---

## Troubleshooting

**"Certificate not trusted" / blank white pane on load**
Run `npx office-addin-dev-certs install` from `apps/word-addin/`, then fully quit and restart Word.

**Add-in shows blank after the cert is trusted**
Right-click the task pane → **Inspect** (or open DevTools via the add-in debug URL) and check the console for errors. A common cause is a missing or wrong `REACT_APP_SUPABASE_URL` / `REACT_APP_SUPABASE_ANON_KEY` — the bundle will have compiled with empty strings if the env vars were not exported before `npm start`.

**Login fails with "Login failed" or a 401**
Run `supabase status` and confirm that the `anon key` in `.env.development` matches exactly. Also confirm `REACT_APP_SUPABASE_URL` ends without a trailing slash and matches the API URL from `supabase status` (default `http://127.0.0.1:54321`).

**"Apply as tracked change" does nothing**
Tracked changes require WordApi 1.4, available in Word 2019 and Microsoft 365. Word on the web does not support this API. Upgrade to Word desktop or use "Insert at cursor" instead.

**Document upload fails**
- Confirm the Mike API is running (`npm run dev:api` from repo root) and reachable at `http://localhost:3001`
- Confirm the `mike` storage bucket exists in Supabase — re-run `scripts/setup-local.sh` to create it if missing
- Check the API server logs for the specific error

**Workflows tab shows "No workflows found"**
Workflows are fetched from `GET /workflows` on the Mike API. Confirm the API is running and that at least one workflow exists in the database.
