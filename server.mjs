import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clientFromEnv } from "./lib/client.mjs";

if (!process.env.MEM0_HOST) {
  console.error("mem0 MCP: MEM0_HOST env var is required (e.g. https://your-mem0-host).");
  process.exit(1);
}

const mem0 = clientFromEnv(process.env);

const server = new McpServer({
  name: "mem0-self-hosted",
  version: "1.1.0",
});

const json = (result) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });

// Shared identity parameters. user_id defaults to MEM0_USER_ID; agent_id is the
// project namespace (hooks write "project:<dir>"); run_id is a Claude Code session id.
const userId = z.string().optional().describe("User ID (defaults to the configured user)");
const agentId = z.string().optional().describe("Agent/project ID, e.g. 'project:my-repo' as written by the session hooks");
const runId = z.string().optional().describe("Run/session ID (a Claude Code session_id)");
const expirationDate = z
  .string()
  .nullable()
  .optional()
  .describe("Expiration date YYYY-MM-DD; expired memories are hidden from search. null clears it.");

server.tool(
  "add_memory",
  "Store a memory. By default mem0 extracts durable facts from the messages and deduplicates against existing memories; pass infer=false to store the message text verbatim.",
  {
    messages: z
      .array(z.object({ role: z.string(), content: z.string() }))
      .describe("Conversation messages (or verbatim facts when infer=false)"),
    user_id: userId,
    agent_id: agentId,
    run_id: runId,
    metadata: z.record(z.any()).optional().describe("Metadata to attach, e.g. {type, project, category}"),
    expiration_date: expirationDate,
    infer: z.boolean().optional().describe("Extract facts with the LLM (default true). false stores each message as-is."),
    memory_type: z.string().optional().describe("Set to 'procedural_memory' for agent procedures (needs agent_id)"),
    prompt: z.string().optional().describe("Custom fact-extraction prompt for this call"),
  },
  async ({ messages, user_id, agent_id, run_id, metadata, expiration_date, infer, memory_type, prompt }) =>
    json(
      await mem0.add({
        messages,
        userId: user_id,
        agentId: agent_id,
        runId: run_id,
        metadata,
        expirationDate: expiration_date,
        infer,
        memoryType: memory_type,
        prompt,
      })
    )
);

server.tool(
  "search_memories",
  "Semantic search over stored memories. Scope with user_id/agent_id/run_id and filter on metadata with mem0 operators (eq, ne, in, nin, gt, gte, lt, lte, contains, icontains, AND/OR/NOT).",
  {
    query: z.string().describe("Search query"),
    user_id: userId,
    agent_id: agentId,
    run_id: runId,
    filters: z
      .record(z.any())
      .optional()
      .describe('Extra metadata filters merged with the identity scope, e.g. {"category": {"in": ["workflows"]}}'),
    limit: z.number().optional().describe("Max results (server default 20)"),
    threshold: z.number().optional().describe("Minimum similarity score 0-1 (server default 0.1)"),
    explain: z.boolean().optional().describe("Include score_details per result"),
    show_expired: z.boolean().optional().describe("Include expired memories"),
  },
  async ({ query, user_id, agent_id, run_id, filters, limit, threshold, explain, show_expired }) =>
    json(
      await mem0.search({
        query,
        userId: user_id,
        agentId: agent_id,
        runId: run_id,
        filters,
        topK: limit,
        threshold,
        explain,
        showExpired: show_expired,
      })
    )
);

server.tool(
  "get_memories",
  "List stored memories for a user, agent/project, and/or run/session (no ranking).",
  {
    user_id: userId,
    agent_id: agentId,
    run_id: runId,
    limit: z.number().optional().describe("Max results, up to 1000"),
    show_expired: z.boolean().optional().describe("Include expired memories"),
  },
  async ({ user_id, agent_id, run_id, limit, show_expired }) =>
    json(await mem0.list({ userId: user_id, agentId: agent_id, runId: run_id, topK: limit, showExpired: show_expired }))
);

server.tool(
  "get_memory",
  "Retrieve a specific memory by its ID.",
  { memory_id: z.string().describe("The memory ID to retrieve") },
  async ({ memory_id }) => json(await mem0.get(memory_id))
);

server.tool(
  "update_memory",
  "Update a memory's text, metadata, and/or expiration date. Only the fields given are changed.",
  {
    memory_id: z.string().describe("The memory ID to update"),
    text: z.string().optional().describe("New memory text"),
    metadata: z.record(z.any()).optional().describe("Replacement metadata"),
    expiration_date: expirationDate,
  },
  async ({ memory_id, text, metadata, expiration_date }) =>
    json(await mem0.update(memory_id, { text, metadata, expirationDate: expiration_date }))
);

server.tool(
  "delete_memory",
  "Delete a specific memory by ID.",
  { memory_id: z.string().describe("The memory ID to delete") },
  async ({ memory_id }) => json(await mem0.remove(memory_id))
);

server.tool(
  "delete_all_memories",
  "Delete all memories in scope. Defaults to the configured user; add agent_id and/or run_id to narrow to one project or session. Use with caution.",
  { user_id: userId, agent_id: agentId, run_id: runId },
  async ({ user_id, agent_id, run_id }) => json(await mem0.removeAll({ userId: user_id, agentId: agent_id, runId: run_id }))
);

server.tool(
  "memory_history",
  "Get the change history of a specific memory.",
  { memory_id: z.string().describe("The memory ID to get history for") },
  async ({ memory_id }) => json(await mem0.history(memory_id))
);

server.tool(
  "list_entities",
  "List every user, agent/project, and run/session that owns memories, with counts.",
  {},
  async () => json(await mem0.listEntities())
);

server.tool(
  "delete_entity",
  "Delete an entity (user, agent, or run) and all of its memories. Use with caution.",
  {
    entity_type: z.enum(["user", "agent", "run"]).describe("Entity type"),
    entity_id: z.string().describe("Entity ID, e.g. a run/session id or 'project:my-repo'"),
  },
  async ({ entity_type, entity_id }) => json(await mem0.deleteEntity(entity_type, entity_id))
);

const transport = new StdioServerTransport();
await server.connect(transport);
