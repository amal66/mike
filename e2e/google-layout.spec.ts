import { test, expect } from "@playwright/test";

// Real browser layout, deterministic synthetic provider data. This does not
// grant Google access or establish live provider acceptance.
for (const width of [390, 768, 1280]) {
  test(`Google connection and approval cards fit a ${width}px viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const accountEmail = `connector.acceptance+${"x".repeat(40)}@example.com`;
    const action = {
      id: "12345678-1234-1234-1234-123456789abc",
      provider: "gmail",
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      resultMessage: null,
      proposal: {
        tool: "gmail_propose_send",
        accountEmail,
        args: {
          to: [accountEmail],
          subject: "Synthetic review",
          body: "x".repeat(300),
        },
      },
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/session")
        return route.fulfill({
          json: {
            user: {
              id: "layout-user",
              email: "login@example.com",
              createdWithGoogle: true,
            },
          },
        });
      if (path === "/api/user/profile")
        return route.fulfill({
          json: {
            onboardingComplete: true,
            displayName: "Layout test",
            apiKeyStatus: {},
            creditsRemaining: 100,
          },
        });
      if (path === "/api/user/google-actions")
        return route.fulfill({ json: { actions: [action] } });
      if (path.includes("/user/integrations/"))
        return route.fulfill({
          json: {
            configured: true,
            schemaReady: true,
            connected: true,
            writeEnabled: true,
            accountEmail,
          },
        });
      return route.fulfill({ json: [] });
    });
    await page.goto("/settings/connectors");
    const approval = page.getByRole("article", { name: "Send email approval" });
    await expect(approval).toBeVisible();
    for (const card of [
      page.getByRole("region", {
        name: "Google Drive connection",
        exact: true,
      }),
      page.getByRole("region", { name: "Gmail connection", exact: true }),
      page.getByRole("region", {
        name: "Google Calendar connection",
        exact: true,
      }),
      approval,
    ]) {
      const size = await card.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          overflow: element.scrollWidth - element.clientWidth,
        };
      });
      expect(size.left).toBeGreaterThanOrEqual(0);
      expect(size.right).toBeLessThanOrEqual(width);
      expect(
        size.overflow,
        `${await card.getAttribute("aria-label")} content overflow`,
      ).toBeLessThanOrEqual(1);
    }
    await expect(
      approval.getByRole("button", { name: "Approve send email" }),
    ).toBeEnabled();
    await expect(
      approval.getByRole("button", { name: "Reject", exact: true }),
    ).toBeEnabled();
  });
}
