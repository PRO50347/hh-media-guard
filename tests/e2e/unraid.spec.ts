import { test, expect } from "@playwright/test";
import { completeWizard } from "./wizard-flow";
const phase = process.env.UNRAID_PHASE || "fresh";
const secret = (service: string) => `fixture-${service}-key`;
test(`Unraid production connections and persistence: ${phase}`, async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  await page.goto("/");
  if (phase === "fresh") {
    await page.getByLabel("Username").fill("fixture-admin");
    await page
      .getByLabel("Password", { exact: true })
      .fill("fixture-password-123");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("heading", { name: /Set up/ })).toBeVisible();
    await completeWizard(page);
  } else {
    await page.getByLabel("Username").fill("fixture-admin");
    await page
      .getByLabel("Password", { exact: true })
      .fill("fixture-password-123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", {
      name: phase === "fresh" ? "Wizard Brand" : "Persistent Unraid Fixture",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/settings");
  const call = async (service: string, data: Record<string, string>) =>
    page.evaluate(
      async ({ service, data }) => {
        const { csrfToken } = await (await fetch("/api/auth")).json();
        const response = await fetch(`/api/integrations/${service}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify(data),
        });
        return { status: response.status, body: await response.json() };
      },
      { service, data },
    );
  for (const service of ["sonarr", "radarr"]) {
    const name = service === "sonarr" ? "Sonarr" : "Radarr";
    const port = service === "sonarr" ? 8989 : 7878;
    const url = `http://connection-fixture:${port}`;
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    if (phase === "fresh") {
      for (const suffix of ["", "/", "/base", "/base/"]) {
        expect(
          (await call(service, { url: url + suffix, apiKey: secret(service) }))
            .status,
        ).toBe(200);
      }
      expect(
        (
          await call(service, {
            url: `https://connection-fixture:${service === "sonarr" ? 9899 : 9999}/base/`,
            apiKey: secret(service),
          })
        ).status,
      ).toBe(200);
      // RFC 5737 documentation address, unreachable from this isolated internal network.
      const unreachable = await call(service, {
        url: "http://192.0.2.1:8989",
        apiKey: secret(service),
      });
      expect(unreachable.status).toBe(400);
      expect(unreachable.body.error).toMatch(/unreachable|timed out/);
      expect(JSON.stringify(unreachable)).not.toContain(secret(service));
      const failures = [
        [{ url, apiKey: "deliberately-invalid-key" }, "401"],
        [{ url: url + "/forbidden", apiKey: secret(service) }, "403"],
        [{ url: url + "/bad-base", apiKey: secret(service) }, "404"],
        [{ url: url + "/unexpected", apiKey: secret(service) }, "Unexpected"],
        [{ url: url + "/html", apiKey: secret(service) }, "Unexpected"],
        [
          {
            url: `http://connection-fixture:${service === "sonarr" ? 7878 : 8989}`,
            apiKey: secret(service === "sonarr" ? "radarr" : "sonarr"),
          },
          "Wrong service",
        ],
        [
          { url: "http://connection-fixture:7654", apiKey: secret(service) },
          "refused",
        ],
        [
          { url: "http://nonexistent.invalid:8989", apiKey: secret(service) },
          "DNS",
        ],
        [{ url: url + "/timeout", apiKey: secret(service) }, "timed out"],
        [
          { url: "https://connection-fixture:9898", apiKey: secret(service) },
          "TLS",
        ],
        [{ url: "not a URL", apiKey: secret(service) }, "Invalid URL"],
        [
          { url: "http://127.0.0.1:3938", apiKey: secret(service) },
          "prohibited",
        ],
      ] as const;
      for (const [data, message] of failures) {
        const result = await call(service, data);
        expect(result.status).toBe(400);
        expect(result.body.error).toContain(message);
        expect(JSON.stringify(result)).not.toContain(data.apiKey);
        expect(JSON.stringify(result)).not.toContain("upstream secret");
      }
      // Test actual unsaved UI state, including invalid-key recovery.
      await card.getByLabel("Enabled", { exact: true }).check();
      await card.getByLabel("Server URL").fill(url + "/base/");
      await card.getByLabel("API key").fill("deliberately-invalid-key");
      await card.getByRole("button", { name: "Test connection" }).click();
      await expect(card.getByRole("status").first()).toContainText("401");
      await card.getByLabel("API key").fill(secret(service));
      await card.getByRole("button", { name: "Test connection" }).click();
      await expect(card.getByRole("status").first()).toContainText(
        "Connected:",
      );
      const unsaved = await page.evaluate(
        async (service) => (await fetch(`/api/integrations/${service}`)).json(),
        service,
      );
      expect(unsaved.apiKeyConfigured).toBe(true);
      expect(unsaved.url).toBe(url + "/base/");
      await card.getByRole("button", { name: `Save ${service}` }).click();
      await expect(card.getByLabel("API key")).toHaveValue("");
      await page.reload();
    }
    await card.getByRole("button", { name: "Test connection" }).click();
    await expect(card.getByRole("status").first()).toContainText(
      phase === "wrong-key" ? "cannot be decrypted" : "Connected:",
    );
    const stored = await page.evaluate(
      async (service) => (await fetch(`/api/integrations/${service}`)).json(),
      service,
    );
    expect(stored.apiKeyConfigured).toBe(true);
    if (phase === "wrong-key")
      expect(stored.lastError).toContain("cannot be decrypted");
    else expect(stored.lastError).toBeFalsy();
    expect(stored).not.toHaveProperty("encrypted_key");
    expect(JSON.stringify(stored)).not.toContain(secret(service));
    expect(await card.getByLabel("API key").inputValue()).toBe("");
  }
  if (phase === "fresh") {
    await page
      .getByLabel("Application name", { exact: true })
      .fill("Persistent Unraid Fixture");
    await page.getByRole("button", { name: "Save appearance" }).click();
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: 16, height: 16 },
    });
    await page.getByLabel("Main logo", { exact: true }).setInputFiles({
      name: "fixture.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(page.getByLabel("Main logo", { exact: true })).toBeEnabled();
    await expect(
      page.getByLabel("Application name", { exact: true }),
    ).toHaveValue("Persistent Unraid Fixture");
  } else
    await expect(
      page.getByLabel("Application name", { exact: true }),
    ).toHaveValue("Persistent Unraid Fixture");
  if (phase !== "wrong-key") {
    // Real UI queues real worker jobs, which must authenticate every enumeration request.
    for (const source of ["sonarr", "radarr"]) {
      await page.goto("/library");
      await page
        .getByRole("combobox", { name: "Integration", exact: true })
        .selectOption(source);
      const queued = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/jobs") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Start library audit" }).click();
      const job = await (await queued).json();
      await expect
        .poll(async () =>
          page.evaluate(
            async (id) =>
              (await (await fetch("/api/jobs")).json()).find(
                (row: { id: string }) => row.id === id,
              ),
            job.id,
          ),
        )
        .toMatchObject({ state: "completed", total: 1, processed: 1 });
      await page.goto(source === "sonarr" ? "/tv" : "/movies");
      await expect(
        page.getByText(
          source === "sonarr" ? /Wizard Episode/ : "Wizard Movie",
          { exact: false },
        ),
      ).toBeVisible();
      await expect(page.getByText("pass", { exact: true })).toBeVisible();
      await page.goto("/history");
      const evidence = page
        .locator("details")
        .filter({
          has: page.locator("summary").filter({ hasText: `${source}.mka` }),
        })
        .first();
      await evidence.locator("summary").first().click();
      await expect(
        evidence.getByText(`${source}-fallback`, { exact: true }),
      ).toBeVisible();
      await expect(
        evidence.getByText("English", { exact: true }),
      ).toBeVisible();
      await expect(evidence.getByText("und", { exact: true })).toBeVisible();
    }
  }
  const logo = await request.get("/api/branding/logo");
  expect(logo.ok()).toBe(true);
  expect(logo.headers()["content-type"]).toContain("image/png");
  const health = await (await request.get("/api/health")).json();
  expect(health).toMatchObject({
    ok: true,
    mode: "monitor",
    destructiveActions: false,
  });
});
