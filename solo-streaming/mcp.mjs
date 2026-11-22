import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { protectedResource } from "./auth.mjs";
import { eventId } from "./events.mjs";

export const mcpScope = "streams:status";
const endpoint = "/mcp";
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function result(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError } : {}) };
}

export function createStreamingMcp({ auth, allowWorkspaces, streams }) {
  const url = new URL(auth.resource);
  if (url.pathname !== endpoint) throw new Error("MCP resource must end in /mcp");
  const resource = protectedResource(auth, [mcpScope]);

  const node = toNodeHandler(createMcpHandler(({ authInfo }) => {
    // Auth is rechecked for each HTTP request. The SDK never receives a replay or publish credential.
    const workspace = authInfo?.extra?.workspace;
    if (!workspace || !allowWorkspaces.has(workspace)) throw new Error("Missing authenticated workspace");
    const server = new McpServer({ name: "paige-cloud-streams", version: "1.0.0" });
    server.registerTool("list_stream_events", {
      description: "List recent private streaming events in the workspace authorized by this connection.",
      annotations,
    }, async () => result({ events: streams.list(workspace) }));
    server.registerTool("get_stream_event_status", {
      description: "Read the status of one streaming event in the authorized workspace. Use an ID from list_stream_events.",
      inputSchema: { id: z.string().regex(eventId) },
      annotations,
    }, async ({ id }) => {
      const stream = await streams.get(workspace, id);
      return stream ? result(stream) : result({ error: "not_found" }, true);
    });
    return server;
  }));

  return async (req, res, { send, body }) => {
    if (req.url === resource.path && req.method === "GET") {
      send(res, 200, resource.metadata);
      return true;
    }
    if (req.url !== endpoint) return false;
    if (req.headers.origin && req.headers.origin !== url.origin) {
      send(res, 403, { error: "origin_denied" });
      return true;
    }
    const principal = await auth.verify(req.headers.authorization);
    if (!principal) {
      send(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": resource.challenge(mcpScope) });
      return true;
    }
    if (!allowWorkspaces.has(principal.workspace) || !principal.scopes.has(mcpScope)) {
      send(res, 403, { error: "insufficient_scope" }, { "WWW-Authenticate": resource.challenge(mcpScope, "insufficient_scope") });
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
      return true;
    }
    const message = await body(req);
    if (!message) {
      send(res, 400, { error: "invalid_mcp_request" });
      return true;
    }
    req.auth = { clientId: principal.clientId, scopes: [mcpScope], expiresAt: principal.expiresAt,
      extra: { workspace: principal.workspace } };
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await node(req, res, message);
    return true;
  };
}
