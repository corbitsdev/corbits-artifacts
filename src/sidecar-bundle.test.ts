import { describe, expect, test } from "bun:test";

import { ARTIFACT_TOOL_DEFINITIONS } from "./tools.js";
import { artifacts, HUB_CREDENTIAL_HANDLE, SIDECAR_BUNDLE_ID } from "./sidecar-bundle.js";

type Recorded = { url: string; init?: RequestInit };

function env(recorded: Recorded[], respond: () => Response) {
  const credential = {
    kind: "http" as const,
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      recorded.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
      return Promise.resolve(respond());
    },
    dispose: () => undefined,
  };
  return {
    address: "run-1@acme.example.com",
    capabilities: {
      resolve: (key: string) => {
        if (key !== "credentials") throw new Error(`unexpected capability ${key}`);
        return {
          resolve: (handle: string) => {
            if (handle !== HUB_CREDENTIAL_HANDLE) {
              throw new Error(`unexpected handle ${handle}`);
            }
            return Promise.resolve(credential);
          },
        };
      },
    },
  } as never;
}

const ok = () =>
  new Response(JSON.stringify({ data: { id: "art_1", version: 1 } }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

const signal = new AbortController().signal;

describe("the artifacts sidecar bundle", () => {
  test("declares every artifact tool under the package-namespaced id", () => {
    expect(artifacts.id).toBe(SIDECAR_BUNDLE_ID);
    expect(artifacts.requires).toEqual(["capabilities", "address"]);
    expect(artifacts.definitions.map((def) => def.name)).toEqual(
      ARTIFACT_TOOL_DEFINITIONS.map((def) => def.name),
    );
  });

  test("creates through the run-scoped route, carrying the run address", async () => {
    const recorded: Recorded[] = [];
    const bundle = artifacts(env(recorded, ok));
    const result = await bundle.run(
      {
        id: "call-1",
        name: "artifact_create",
        arguments: { title: "Notes", kind: "document", content: "body" },
      },
      signal,
    );

    expect(result.isError).toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("/api/workflow-artifacts/artifacts");
    const headers = recorded[0]?.init?.headers as Record<string, string>;
    expect(headers["x-workflow-run-address"]).toBe("run-1@acme.example.com");
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({
      title: "Notes",
      kind: "document",
      content: "body",
    });
  });

  test("reads a pinned version through the read route", async () => {
    const recorded: Recorded[] = [];
    const bundle = artifacts(env(recorded, ok));
    await bundle.run(
      { id: "call-2", name: "artifact_read", arguments: { artifactId: "art_1", version: 3 } },
      signal,
    );
    expect(recorded[0]?.url).toBe("/api/workflow-artifacts/artifacts/art_1/read?version=3");
  });

  test("resolves the credential once across calls", async () => {
    const recorded: Recorded[] = [];
    const bundle = artifacts(env(recorded, ok));
    await bundle.run({ id: "a", name: "artifact_list", arguments: {} }, signal);
    await bundle.run({ id: "b", name: "artifact_list", arguments: {} }, signal);
    expect(recorded).toHaveLength(2);
    await bundle.dispose?.();
  });

  test("a hub error comes back as a tool error, never a throw", async () => {
    const recorded: Recorded[] = [];
    const bundle = artifacts(
      env(
        recorded,
        () =>
          new Response(JSON.stringify({ error: "Artifact not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await bundle.run(
      { id: "c", name: "artifact_read", arguments: { artifactId: "missing" } },
      signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Artifact not found");
  });

  test("an unknown tool name is a tool error", async () => {
    const recorded: Recorded[] = [];
    const bundle = artifacts(env(recorded, ok));
    const result = await bundle.run({ id: "d", name: "artifact_nope", arguments: {} }, signal);
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});
