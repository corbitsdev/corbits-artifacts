// Sidecar-bundle entry for `@corbits/artifacts` — the convention-compliant
// factory the tool-package loader invokes, so a deployed agent carries the
// artifact tools without any agent-owned client code.
//
// The bundle holds no database handle and no secret. It resolves the `hub`
// credential handle from the host-assembled runtime capabilities and calls
// the run-scoped artifact routes through that mediated fetch, which is
// pinned to the hub's own origin and injects the agent's bearer per request.
// The env keys it touches (`capabilities`, `address`) are declared in
// `requires`: `address` is the run address the routes scope every call to.
import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";

import { ARTIFACT_TOOL_DEFINITIONS } from "./tools.js";

/** Where a host mounts `mountWorkflowArtifacts`. The bundle has no options of
 * its own — the loader constructs it — so the path is a shared constant
 * rather than per-deploy configuration. */
export const WORKFLOW_ARTIFACTS_BASE_PATH = "/api/workflow-artifacts";

/** The credential handle this package declares, and the one a host binds the
 * agent's hub token to. */
export const HUB_CREDENTIAL_HANDLE = "hub";

export const SIDECAR_BUNDLE_ID = "@corbits/artifacts/sidecar-bundle";

/** The env keys `requires` declares, on top of the six core ones. */
export type ArtifactsToolEnv = BaseEnv & {
  readonly capabilities: RuntimeCapabilities;
  readonly address: string;
};

type MediatedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Request_ = {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly body?: Record<string, unknown>;
};

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Maps one model-facing tool call onto the run-scoped route that performs
 * it. An unknown name returns undefined and answers as a tool error. */
function requestFor(name: string, args: Record<string, unknown>): Request_ | undefined {
  switch (name) {
    case "artifact_create":
      return {
        method: "POST",
        path: "/artifacts",
        body: {
          title: args["title"],
          kind: args["kind"],
          content: args["content"],
          ...(args["metadata"] !== undefined ? { metadata: args["metadata"] } : {}),
        },
      };
    case "artifact_link_file":
      return {
        method: "POST",
        path: "/artifacts/link-file",
        body: {
          title: args["title"],
          kind: args["kind"],
          path: args["path"],
          ...(str(args["preview"]) !== undefined ? { preview: args["preview"] } : {}),
        },
      };
    case "artifact_read":
      return {
        method: "GET",
        path: `/artifacts/${encodeURIComponent(String(args["artifactId"] ?? ""))}/read${query({
          version: args["version"],
          path: args["path"],
        })}`,
      };
    case "artifact_read_chunk":
      return {
        method: "GET",
        path: `/artifacts/${encodeURIComponent(String(args["artifactId"] ?? ""))}/chunk${query({
          version: args["version"],
          offset: args["offset"],
          limit: args["limit"],
        })}`,
      };
    case "artifact_write":
      return {
        method: "PATCH",
        path: `/artifacts/${encodeURIComponent(String(args["artifactId"] ?? ""))}`,
        body: {
          ...(str(args["title"]) !== undefined ? { title: args["title"] } : {}),
          ...(typeof args["content"] === "string" ? { content: args["content"] } : {}),
          ...(args["metadata"] !== undefined ? { metadata: args["metadata"] } : {}),
        },
      };
    case "artifact_list":
      return {
        method: "GET",
        path: `/artifacts${query({ kind: args["kind"], limit: args["limit"] })}`,
      };
    case "artifact_find_by_title":
      return {
        method: "GET",
        path: `/artifacts/find${query({ title: args["title"], kind: args["kind"] })}`,
      };
    default:
      return undefined;
  }
}

/** The loader may present a namespaced name; the switch above keys on the
 * declared one. */
function bareToolName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

async function readErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
  }
  return `the hub answered ${String(response.status)}`;
}

/** The path is relative on purpose: a mediated http handle resolves it
 * against the origin it is pinned to, so the bundle never names a host. */
export async function callArtifactRoute(
  fetchImpl: MediatedFetch,
  runAddress: string,
  request: Request_,
): Promise<unknown> {
  const response = await fetchImpl(`${WORKFLOW_ARTIFACTS_BASE_PATH}${request.path}`, {
    method: request.method,
    headers: {
      "x-workflow-run-address": runAddress,
      ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

/**
 * The named export the loader picks up. `factory` is synchronous while the
 * credential resolve is not, so the handle is resolved lazily on first use
 * and the promise memoized — one resolve, one handle to dispose.
 */
export const artifacts = defineTool<ArtifactsToolEnv>({
  id: SIDECAR_BUNDLE_ID,
  requires: ["capabilities", "address"],
  definitions: ARTIFACT_TOOL_DEFINITIONS.map((def) => ({ name: def.name })),
  factory: (env) => {
    let handle: Promise<{ fetch: MediatedFetch; dispose(): void | Promise<void> }> | undefined;

    function hub() {
      handle ??= (async () => {
        const credential = await env.capabilities.resolve("credentials").resolve(
          HUB_CREDENTIAL_HANDLE,
        );
        if (credential.kind !== "http") {
          throw new Error(
            `the "${HUB_CREDENTIAL_HANDLE}" credential is a ${credential.kind} handle; the artifact tools need an http one`,
          );
        }
        return {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            credential.fetch(input, init),
          dispose: () => credential.dispose(),
        };
      })();
      return handle;
    }

    return {
      definitions: ARTIFACT_TOOL_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema as unknown as Record<string, unknown>,
      })),
      async run(call: ToolCall): Promise<ToolResult> {
        const name = bareToolName(call.name);
        const request = requestFor(name, call.arguments);
        if (request === undefined) {
          return { callId: call.id, content: `unknown artifact tool: ${call.name}`, isError: true };
        }
        try {
          const { fetch: mediated } = await hub();
          const data = await callArtifactRoute(mediated, env.address, request);
          return { callId: call.id, content: JSON.stringify(data) };
        } catch (error) {
          return {
            callId: call.id,
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
      async dispose() {
        if (handle === undefined) return;
        await (await handle).dispose();
      },
    };
  },
});
