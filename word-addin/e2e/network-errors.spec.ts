/**
 * Word's WebView collapses every transport failure into "Load failed", which
 * tells the user nothing about what could not be reached. These tests pin the
 * replacement: one concise sentence that still names the server origin, so a
 * self-hoster knows whether to check their connection or their own API.
 */
import { test, expect } from "./support/fixtures";

test("a failed sign-in request names the request instead of only 'Load failed'", async ({
  addin,
  page,
}) => {
  await page.route("**/auth/login", (route) => route.abort("failed"));
  await addin.gotoTaskpane();

  await page
    .getByRole("textbox", { name: "Email" })
    .fill("lawyer@firm.com");
  await page.getByRole("textbox", { name: "Password" }).fill("hunter2");
  await page.getByRole("button", { name: "Log in" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  const text = await alert.innerText();
  expect(text).toContain("Mike couldn't reach the server at");
  // The origin is named so a self-hoster knows which server is down.
  expect(text).toMatch(/http:\/\/(127\.0\.0\.1|localhost):\d+/);
  expect(text).toContain("Check your connection and that the server is running");
  // The host's opaque wording never reaches the screen.
  expect(text).not.toMatch(/Failed to fetch|Load failed|NetworkError/);
});

test("a rejected sign-in shows what the server said, not a generic failure", async ({
  addin,
  page,
}) => {
  await page.route("**/auth/login", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "invalid_credentials",
        detail: "Invalid login credentials",
      }),
    })
  );
  await addin.gotoTaskpane();

  await page
    .getByRole("textbox", { name: "Email" })
    .fill("lawyer@firm.com");
  await page.getByRole("textbox", { name: "Password" }).fill("wrong");
  await page.getByRole("button", { name: "Log in" }).click();

  // A 4xx `detail` is written for the user by the backend, so it is shown
  // as-is — without the "(HTTP 400)" suffix, which meant nothing to anyone.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Invalid login credentials");
  await expect(alert).not.toContainText("HTTP 400");
});

test("a failed workflow load names the endpoint it could not reach", async ({
  addin,
  page,
}) => {
  addin.seedToken("seeded-jwt");
  await page.route("**/workflows**", (route) => route.abort("failed"));
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Workflows" }).click();

  // The list says what happened, and the toast adds a Retry.
  await expect(
    page.getByText(/Mike couldn't reach the server at/).first(),
  ).toBeVisible();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Couldn't load your workflows");
  await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();
});
