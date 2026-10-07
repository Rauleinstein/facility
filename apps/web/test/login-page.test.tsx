// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "../app/login/page";

type Methods = { local: boolean; external: "github" | "oidc" | null };
const mocks = vi.hoisted(() => ({
  result: { ok: true, data: { local: false, external: null } } as
    | { ok: true; data: Methods }
    | { ok: false; status: number; offline: boolean; message: string },
}));
vi.mock("../lib/api", () => ({ api: { authMethods: async () => mocks.result } }));

async function render(result: typeof mocks.result) {
  mocks.result = result;
  return renderToStaticMarkup(await LoginPage());
}

describe("login page", () => {
  it("offers both GitHub and local login when the API enables both", async () => {
    const html = await render({ ok: true, data: { local: true, external: "github" } });
    expect(html).toContain('href="/api/auth/login"');
    expect(html).toContain("continue with GitHub");
    expect(html).toContain('href="/api/auth/dev-login"');
    expect(html).toContain("continue locally");
  });

  it("does not offer local login when the API has it disabled", async () => {
    const html = await render({ ok: true, data: { local: false, external: "github" } });
    expect(html).toContain("continue with GitHub");
    expect(html).not.toContain("/api/auth/dev-login");
  });

  it("does not offer GitHub login when no identity provider is configured", async () => {
    const html = await render({ ok: true, data: { local: true, external: null } });
    expect(html).toContain("continue locally");
    expect(html).not.toContain('href="/api/auth/login"');
  });

  it("labels OIDC as SSO", async () => {
    const html = await render({ ok: true, data: { local: false, external: "oidc" } });
    expect(html).toContain("continue with SSO");
  });

  it("explains when no sign-in method is configured", async () => {
    const html = await render({ ok: true, data: { local: false, external: null } });
    expect(html).toContain("No sign-in method is configured");
    expect(html).not.toContain("/api/auth/");
  });

  it("shows the offline notice instead of guessing when the API is down", async () => {
    const html = await render({ ok: false, status: 0, offline: true, message: "fetch failed" });
    expect(html).toContain("control plane unreachable");
    expect(html).not.toContain("/api/auth/");
  });
});
