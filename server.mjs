import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MEM0_HOST = process.env.MEM0_HOST;
const MEM0_USER_ID = process.env.MEM0_USER_ID || "claude-code";

if (!MEM0_HOST) {
  console.error("mem0 MCP: MEM0_HOST env var is required (e.g. https://your-mem0-host).");
  process.exit(1);
}

async function mem0Fetch(path, options = {}) {
  const url = `${MEM0_HOST}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mem0 API error ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "mem0-self-hosted",
  version: "1.0.0",
});

server.tool(
  "add_memory",
  "Store a memory from conversation messages. Memories are automatically extracted and deduplicated.",
  {
    messages: z
      .array(z.object({ role: z.string(), content: z.string() }))
      .describe("Conversation messages to extract memories from"),
    user_id: z
      .string()
      .optional()
      .describe("User ID to associate memories with"),
    metadata: z
      .record(z.any())
      .optional()
      .describe("Optional metadata to attach"),
  },
  async ({ messages, user_id, metadata }) => {
    const body = { messages, user_id: user_id || MEM0_USER_ID };
    if (metadata) body.metadata = metadata;
    const result = await mem0Fetch("/memories", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "search_memories",
  "Search stored memories by semantic similarity.",
  {
    query: z.string().describe("Search query"),
    user_id: z
      .string()
      .optional()
      .describe("Filter by user ID"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 10)"),
  },
  async ({ query, user_id, limit }) => {
    const body = { query, user_id: user_id || MEM0_USER_ID };
    if (limit) body.top_k = limit;
    const result = await mem0Fetch("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_memories",
  "List all stored memories, optionally filtered by user ID.",
  {
    user_id: z
      .string()
      .optional()
      .describe("Filter by user ID"),
  },
  async ({ user_id }) => {
    const uid = user_id || MEM0_USER_ID;
    const result = await mem0Fetch(`/memories?user_id=${encodeURIComponent(uid)}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_memory",
  "Retrieve a specific memory by its ID.",
  {
    memory_id: z.string().describe("The memory ID to retrieve"),
  },
  async ({ memory_id }) => {
    const result = await mem0Fetch(`/memories/${encodeURIComponent(memory_id)}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "update_memory",
  "Update an existing memory by ID.",
  {
    memory_id: z.string().describe("The memory ID to update"),
    text: z.string().describe("New memory text"),
  },
  async ({ memory_id, text }) => {
    const result = await mem0Fetch(`/memories/${encodeURIComponent(memory_id)}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "delete_memory",
  "Delete a specific memory by ID.",
  {
    memory_id: z.string().describe("The memory ID to delete"),
  },
  async ({ memory_id }) => {
    const result = await mem0Fetch(`/memories/${encodeURIComponent(memory_id)}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "delete_all_memories",
  "Delete all memories for a user. Use with caution.",
  {
    user_id: z
      .string()
      .optional()
      .describe("User ID whose memories to delete"),
  },
  async ({ user_id }) => {
    const uid = user_id || MEM0_USER_ID;
    const result = await mem0Fetch(`/memories?user_id=${encodeURIComponent(uid)}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "memory_history",
  "Get the change history of a specific memory.",
  {
    memory_id: z.string().describe("The memory ID to get history for"),
  },
  async ({ memory_id }) => {
    const result = await mem0Fetch(
      `/memories/${encodeURIComponent(memory_id)}/history`
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
