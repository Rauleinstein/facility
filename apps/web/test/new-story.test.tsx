// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewStory } from "../components/story/new-story";
import { engineIdentity, providerIdentity } from "../lib/ai-identity";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <NewStory
        projectId="proj_test"
        agents={[
          {
            name: "builder",
            description: "Builds",
            engine: engineIdentity("codex"),
            provider: providerIdentity("openai"),
            model: "gpt-5.6-sol",
            isDefault: true,
          },
        ]}
        defaultAgent="builder"
        titleGeneration={false}
        linked={null}
        clearHref="/projects/proj_test/stories"
      />,
    ),
  );
  const textarea = container.querySelector("textarea");
  if (!textarea) throw Error("Missing request box");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(textarea, "Add subtract");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function submit() {
  const form = container.querySelector("form");
  if (!form) throw Error("Missing form");
  await act(async () => form.requestSubmit());
}
function keys(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.map(
    ([, init]) =>
      (init as RequestInit & { headers: Record<string, string> }).headers["idempotency-key"],
  );
}
const rejected = () =>
  new Response(JSON.stringify({ error: { code: "project_environment_invalid", message: "bad" } }), {
    status: 409,
  });

it("uses a new idempotency key after a definite rejection, so a retry is not a replay", async () => {
  const fetch = vi.fn(async () => rejected());
  vi.stubGlobal("fetch", fetch);
  await submit();
  await submit();
  const [first, second] = keys(fetch);
  expect(first).toMatch(/^ui-start-/);
  expect(second).toMatch(/^ui-start-/);
  expect(second).not.toBe(first);
});

it("reuses the idempotency key when the outcome is unknown", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("network down"))
    .mockResolvedValueOnce(new Response("{}", { status: 503 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "idempotency_in_progress", message: "wait" } }),
        {
          status: 409,
        },
      ),
    )
    .mockResolvedValue(rejected());
  vi.stubGlobal("fetch", fetch);
  for (let attempt = 0; attempt < 4; attempt += 1) await submit();
  const [first, second, third, fourth] = keys(fetch);
  expect(second).toBe(first);
  expect(third).toBe(first);
  expect(fourth).toBe(first);
});
