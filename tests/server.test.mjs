import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeMem0 } from "./helpers/fake-mem0.mjs";

let mem0, client;
const last = () => mem0.requests.at(-1);

before(async () => {
  mem0 = await startFakeMem0();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../server.mjs")],
    env: { ...process.env, MEM0_HOST: mem0.host, MEM0_USER_ID: "doug", MEM0_API_KEY: "key-1" },
  });
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await mem0.close();
});

test("exposes the entity tools alongside the memory tools", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_memory", "delete_all_memories", "delete_entity", "delete_memory", "get_memories",
    "get_memory", "list_entities", "memory_history", "search_memories", "update_memory",
  ]);
});

test("search_memories sends identity in filters plus the new retrieval knobs", async () => {
  await client.callTool({ name: "search_memories", arguments: {
    query: "q", agent_id: "project:p", run_id: "s1", limit: 7, threshold: 0.3, explain: true,
    show_expired: true, filters: { category: "workflows" },
  } });
  assert.equal(last().path, "/search");
  assert.deepEqual(last().body, {
    query: "q",
    filters: { user_id: "doug", agent_id: "project:p", run_id: "s1", category: "workflows" },
    top_k: 7, threshold: 0.3, explain: true, show_expired: true,
  });
});

test("search_memories defaults to the configured user and nothing else", async () => {
  await client.callTool({ name: "search_memories", arguments: { query: "q" } });
  assert.deepEqual(last().body, { query: "q", filters: { user_id: "doug" } });
});

test("every request carries the configured api key", async () => {
  await client.callTool({ name: "get_memory", arguments: { memory_id: "m1" } });
  assert.equal(last().headers["x-api-key"], "key-1");
});

test("add_memory forwards scope, expiry, infer, memory_type and prompt", async () => {
  const messages = [{ role: "user", content: "fact" }];
  await client.callTool({ name: "add_memory", arguments: {
    messages, agent_id: "project:p", run_id: "s1", metadata: { type: "curated" },
    expiration_date: "2027-01-01", infer: false, memory_type: "procedural_memory", prompt: "p",
  } });
  assert.equal(last().method, "POST");
  assert.equal(last().path, "/memories");
  assert.deepEqual(last().body, {
    messages, user_id: "doug", agent_id: "project:p", run_id: "s1", metadata: { type: "curated" },
    expiration_date: "2027-01-01", infer: false, memory_type: "procedural_memory", prompt: "p",
  });
});

test("get_memories accepts agent/run scope, limit and show_expired", async () => {
  await client.callTool({ name: "get_memories", arguments: { agent_id: "project:p", run_id: "s1", limit: 200, show_expired: true } });
  assert.equal(last().path, "/memories");
  assert.deepEqual(last().query, { user_id: "doug", agent_id: "project:p", run_id: "s1", top_k: "200", show_expired: "true" });
});

test("update_memory can change metadata or expiry without touching the text", async () => {
  await client.callTool({ name: "update_memory", arguments: { memory_id: "m1", metadata: { category: "results" } } });
  assert.equal(last().method, "PUT");
  assert.equal(last().path, "/memories/m1");
  assert.deepEqual(last().body, { metadata: { category: "results" } });
  await client.callTool({ name: "update_memory", arguments: { memory_id: "m1", text: "new", expiration_date: null } });
  assert.deepEqual(last().body, { text: "new", expiration_date: null });
});

test("delete_all_memories can target a single session", async () => {
  await client.callTool({ name: "delete_all_memories", arguments: { run_id: "s1" } });
  assert.equal(last().method, "DELETE");
  assert.deepEqual(last().query, { user_id: "doug", run_id: "s1" });
});

test("list_entities and delete_entity hit the entities router", async () => {
  const r = await client.callTool({ name: "list_entities", arguments: {} });
  assert.equal(last().path, "/entities");
  assert.match(r.content[0].text, /"doug"/);
  await client.callTool({ name: "delete_entity", arguments: { entity_type: "run", entity_id: "s1" } });
  assert.equal(last().method, "DELETE");
  assert.equal(last().path, "/entities/run/s1");
});

test("API errors come back as MCP tool errors, not crashes", async () => {
  const bad = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../server.mjs")],
    env: { ...process.env, MEM0_HOST: "http://127.0.0.1:1", MEM0_USER_ID: "doug" },
  });
  const c = new Client({ name: "t2", version: "0" });
  await c.connect(bad);
  const r = await c.callTool({ name: "get_memory", arguments: { memory_id: "x" } });
  assert.equal(r.isError, true);
  await c.close();
});
