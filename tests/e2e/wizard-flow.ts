import { expect, type Page } from "@playwright/test";
export async function completeWizard(page: Page) {
  const next = () =>
    page.getByRole("button", { name: "Continue", exact: true }).click();
  const back = () =>
    page.getByRole("button", { name: "Back", exact: true }).click();
  const active = page.locator(
    '[aria-label="Setup progress"] [aria-current="step"]',
  );
  await next();
  await page
    .getByLabel("Application name", { exact: true })
    .fill("Wizard Brand");
  await page.getByLabel("Suite name", { exact: true }).fill("Wizard Suite");
  await page.getByLabel("Short name", { exact: true }).fill("Wizard");
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await page.getByLabel("Accent", { exact: true }).fill("#123456");
  await page.getByLabel("Show suite branding").uncheck();
  await page.getByRole("button", { name: "Add suite link" }).click();
  const link = page.getByRole("group", { name: "Application 1", exact: true });
  await link.getByLabel("name", { exact: true }).fill("Wizard Link");
  await link
    .getByLabel("url", { exact: true })
    .fill("https://example.test/suite");
  const png = await page.screenshot({
    clip: { x: 0, y: 0, width: 16, height: 16 },
  });
  for (const label of ["Main logo", "Compact / header logo", "Login artwork"]) {
    await page.getByLabel(label, { exact: true }).setInputFiles({
      name: "wizard.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
  }
  await expect(
    page.getByLabel("Application name", { exact: true }),
  ).toHaveValue("Wizard Brand");
  // A rejected save cannot advance or discard the input.
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture save unavailable" }),
      });
    else await route.continue();
  });
  await next();
  await expect(
    page.getByText("Fixture save unavailable", { exact: true }),
  ).toBeVisible();
  await expect(active).toContainText("Branding");
  await expect(
    page.getByLabel("Application name", { exact: true }),
  ).toHaveValue("Wizard Brand");
  await page.unroute("**/api/settings");
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "POST") {
      const response = await route.fetch();
      await wait;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await next();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await expect(active).toContainText("Branding");
  resume();
  await expect(active).toContainText("Sonarr");
  await page.unroute("**/api/settings");
  // Returning to a saved step uses persisted branding, not old server props.
  await expect(page.getByLabel("Server URL")).toBeVisible();
  await back();
  await expect(
    page.getByLabel("Application name", { exact: true }),
  ).toHaveValue("Wizard Brand");
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toHaveValue("light");
  await next();
  for (const [source, port] of [
    ["sonarr", 8989],
    ["radarr", 7878],
  ] as const) {
    await expect(active).toContainText(
      source === "sonarr" ? "Sonarr" : "Radarr",
    );
    await page.getByLabel("Enabled", { exact: true }).check();
    await page
      .getByLabel("Server URL")
      .fill(`http://connection-fixture:${port}/base/`);
    await page.getByLabel("API key").fill(`fixture-${source}-key`);
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText(/^Connected:/)).toBeVisible();
    const unsaved = await page.evaluate(
      async (source) => (await fetch(`/api/integrations/${source}`)).json(),
      source,
    );
    expect(unsaved.apiKeyConfigured).toBe(false);
    if (source === "sonarr") {
      await page.route("**/api/integrations/sonarr", async (route) => {
        if (route.request().method() === "PUT")
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"Fixture credential save unavailable"}',
          });
        else await route.continue();
      });
      await next();
      await expect(
        page.getByText("Fixture credential save unavailable", { exact: true }),
      ).toBeVisible();
      await expect(active).toContainText("Sonarr");
      await expect(page.getByLabel("API key")).toHaveValue(
        "fixture-sonarr-key",
      );
      await page.unroute("**/api/integrations/sonarr");
    }
    // No explicit Save: Continue must await encrypted persistence.
    await next();
    if (source === "sonarr")
      await expect(page.getByLabel("Server URL")).toHaveValue("");
    await back();
    await expect(page.getByLabel("Server URL")).toHaveValue(
      `http://connection-fixture:${port}/base/`,
    );
    await expect(page.getByLabel("API key")).toHaveValue("");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText(/^Connected:/)).toBeVisible();
    if (source === "sonarr") {
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Set up Wizard", exact: true }),
      ).toBeVisible();
      await next();
      await expect(
        page.getByLabel("Application name", { exact: true }),
      ).toHaveValue("Wizard Brand");
      await next();
      await expect(page.getByLabel("API key")).toHaveValue("");
      await expect(page.getByLabel("Server URL")).toHaveValue(
        `http://connection-fixture:${port}/base/`,
      );
    }
    await next();
  }
  await expect(active).toContainText("Path mappings");
  for (const [source, root] of [
    ["sonarr", "/arr/tv"],
    ["radarr", "/arr/movies"],
  ]) {
    await page
      .getByRole("combobox", { name: "Source", exact: true })
      .selectOption(source);
    await page.getByLabel("Arr-visible path").fill(root);
    await page.getByLabel("Container-visible path").fill("/Media");
    await page.getByRole("button", { name: "Add mapping" }).click();
    await expect(
      page.getByText("Mapping saved", { exact: true }),
    ).toBeVisible();
  }
  await next();
  await page
    .getByLabel("Required language codes (comma separated)")
    .fill("eng,fra");
  await next();
  await back();
  await expect(
    page.getByLabel("Required language codes (comma separated)"),
  ).toHaveValue("eng,fra");
  await next();
  for (const name of ["Sonarr", "Radarr"]) {
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "Test connection" }).click();
    await expect(card.getByText(/^Connected:/)).toBeVisible();
  }
  await next();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(
    page.getByRole("heading", { name: "Wizard Brand", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Wizard Brand", exact: true }),
  ).toBeVisible();
  for (const kind of ["logo", "compact", "background"]) {
    const response = await page.request.get(`/api/branding/${kind}`);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/branding/fox-logo.png",
  );
  const settings = await page.evaluate(async () =>
    (await fetch("/api/settings")).json(),
  );
  expect(settings).toMatchObject({
    appName: "Wizard Brand",
    suiteName: "Wizard Suite",
    shortName: "Wizard",
    theme: "light",
    accent: "#123456",
    showSuite: false,
    requiredLanguages: ["eng", "fra"],
    safetyMode: "monitor",
    setupComplete: true,
    suiteLinks: [{ name: "Wizard Link", url: "https://example.test/suite" }],
  });
}
