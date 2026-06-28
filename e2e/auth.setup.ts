import { test as setup, expect } from "@playwright/test";
import path from "path";

const authFile = path.join(__dirname, ".auth/user.json");

setup("authenticate", async ({ page }) => {
    const email = process.env.E2E_EMAIL;
    const password = process.env.E2E_PASSWORD;

    if (!email || !password) {
        throw new Error(
            "E2E_EMAIL and E2E_PASSWORD environment variables are required",
        );
    }

    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);

    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click('button[type="submit"]');

    /* After login the app redirects to /assistant */
    await page.waitForURL(/\/assistant/, { timeout: 15_000 });

    /* Save the authenticated session for all subsequent tests */
    await page.context().storageState({ path: authFile });
});
