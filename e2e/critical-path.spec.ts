/**
 * Critical path E2E tests:
 *   1. Authenticated landing — /assistant loads correctly
 *   2. Projects — create a project, upload a PDF, open the project assistant,
 *      send a message and verify a response begins streaming
 *
 * Prerequisite: auth.setup.ts has already saved the session to e2e/.auth/user.json
 */
import { test, expect } from "@playwright/test";
import path from "path";

const PDF_FIXTURE = path.join(__dirname, "fixtures/test.pdf");

/* ─── Test 1: authenticated landing ─────────────────────────────────────── */

test("authenticated user lands on the assistant page", async ({ page }) => {
    await page.goto("/assistant");
    await expect(page).toHaveURL(/\/assistant/);
    /* The InitialView renders a greeting heading */
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
});

/* ─── Test 2: create project → upload PDF → chat ─────────────────────────── */

test("create project, upload PDF, ask a question and receive a response", async ({
    page,
}) => {
    /* ── Step 1: navigate to projects ─────────────────────────────────────── */
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/);

    /* ── Step 2: open the "New project" modal ────────────────────────────── */
    /* The Plus icon button in the header has aria-label="New project" */
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    /* ── Step 3: fill in the project name ─────────────────────────────────── */
    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    const projectName = `E2E Test Project ${Date.now()}`;
    await nameInput.fill(projectName);

    /* ── Step 4: upload a PDF via the hidden file input ───────────────────── */
    const uploadBtn = page.getByText(/Upload files/);
    /* We need to trigger the hidden file input; intercept the chooser */
    const fileChooserPromise = page.waitForEvent("filechooser");
    await uploadBtn.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PDF_FIXTURE);

    /* The button label should update to reflect the queued file */
    await expect(page.getByText(/Upload files \(1\)/)).toBeVisible({
        timeout: 5_000,
    });

    /* ── Step 5: submit the form ──────────────────────────────────────────── */
    await page.click('button[type="submit"]');

    /* After creation the modal closes and we should see the new project row */
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 15_000 });

    /* ── Step 6: open the project ─────────────────────────────────────────── */
    await page.getByText(projectName).click();
    /* Should navigate to /projects/[id] (Documents tab by default) */
    await expect(page).toHaveURL(/\/projects\/.+/, { timeout: 10_000 });

    /* The project assistant lives at ?tab=assistant. Navigate there directly
       rather than clicking through the tab bar to avoid ambiguity with the
       "Assistant" item in the sidebar nav. */
    await page.goto(page.url() + "?tab=assistant");
    await page.waitForLoadState("networkidle");

    /* The assistant tab shows a chat list. Click "+ Create New" to open the
       chat interface where the text input appears. */
    await page.getByText("+ Create New").click();
    /* Navigates to /projects/{id}/assistant (new chat UI) */
    await page.waitForURL(/\/projects\/.+\/assistant/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    /* ── Step 7: type a question in the chat input ────────────────────────── */
    const chatInput = page.getByPlaceholder(
        "Ask a question about your documents...",
    );
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    await chatInput.fill("What is this document about?");
    /* Submit with Ctrl+Enter (the chat component intercepts keyboard events) */
    await chatInput.press("Control+Enter");

    /* ── Step 8: verify a response begins ────────────────────────────────── */
    /* A loading indicator or first response token appears */
    /* We look for any element that indicates the assistant is responding */
    await expect(
        page.locator('[data-testid="loading"], .animate-pulse, [aria-busy="true"]').first().or(
            /* Fallback: any new non-empty text appears after the question */
            page.locator("text=…").first()
        ),
    ).toBeVisible({ timeout: 30_000 }).catch(async () => {
        /* If none of the above appear, at minimum the input should be disabled
           while the stream is in flight, proving the request was sent */
        await expect(chatInput).toBeDisabled({ timeout: 30_000 });
    });
});

/* ─── Test 3: login-page redirect for unauthenticated users ──────────────── */

/* describe-scoped test.use so only this test runs without a stored session.
   File-level test.use would wipe the storageState for all tests in this file. */
test.describe("unauthenticated", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("unauthenticated request to /assistant redirects to login", async ({
        page,
    }) => {
        await page.goto("/assistant");
        /* Auth check is client-side (Supabase getSession) — allow time for the
           async check to resolve and for Next.js router.push to fire. */
        await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    });
});
