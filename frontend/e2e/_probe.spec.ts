import { test } from "@playwright/test";

test("probe account models + api-keys", async ({ page }) => {
    for (const path of ["/account/models", "/account/api-keys", "/account"]) {
        await page.goto(path);
        await page.waitForTimeout(2500);
        const h2s = await page.locator("h1,h2").allInnerTexts();
        console.log(`PROBE ${path} HEADINGS:`, JSON.stringify(h2s));
    }
});
