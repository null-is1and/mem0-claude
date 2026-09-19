import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../lib/client.mjs";

function fakeFetch(responseBody = { results: [] }) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: true, status: 200, json: async () => responseBody, text: async () => "" };
  };
  return { fetch, calls };
}

test("search puts identity inside filters, never top-level", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.search({ query: "q" });
  assert.equal(calls[0].url, "http://m/search");
  assert.deepEqual(calls[0].body, { query: "q", filters: { user_id: "doug" } });
});

test("search forwards agent/run ids, threshold, explain, show_expired, top_k and extra filters", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.search({
    query: "q", agentId: "proj", runId: "s1", topK: 5, threshold: 0.4, explain: true,
    showExpired: true, filters: { category: { in: ["workflows"] } },
  });
  assert.deepEqual(calls[0].body, {
    query: "q",
    filters: { user_id: "doug", agent_id: "proj", run_id: "s1", category: { in: ["workflows"] } },
    top_k: 5, threshold: 0.4, explain: true, show_expired: true,
  });
});

test("search with explicit userId overrides the default", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.search({ query: "q", userId: "other" });
  assert.equal(calls[0].body.filters.user_id, "other");
});

test("add forwards every write parameter the REST server accepts", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  const messages = [{ role: "user", content: "x" }];
  await c.add({
    messages, agentId: "proj", runId: "s1", metadata: { type: "t" }, expirationDate: "2026-12-01",
    infer: false, memoryType: "procedural_memory", prompt: "p",
  });
  assert.equal(calls[0].url, "http://m/memories");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].body, {
    messages, user_id: "doug", agent_id: "proj", run_id: "s1", metadata: { type: "t" },
    expiration_date: "2026-12-01", infer: false, memory_type: "procedural_memory", prompt: "p",
  });
});

test("add omits undefined fields so the server keeps its defaults", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.add({ messages: [] });
  assert.deepEqual(calls[0].body, { messages: [], user_id: "doug" });
});

test("list builds query string with all scope params", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.list({ agentId: "a b", runId: "r", topK: 50, showExpired: true });
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/memories");
  assert.equal(u.searchParams.get("user_id"), "doug");
  assert.equal(u.searchParams.get("agent_id"), "a b");
  assert.equal(u.searchParams.get("run_id"), "r");
  assert.equal(u.searchParams.get("top_k"), "50");
  assert.equal(u.searchParams.get("show_expired"), "true");
});

test("update sends only the fields provided", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.update("id1", { metadata: { k: 1 } });
  assert.equal(calls[0].url, "http://m/memories/id1");
  assert.equal(calls[0].options.method, "PUT");
  assert.deepEqual(calls[0].body, { metadata: { k: 1 } });
  await c.update("id1", { text: "t", expirationDate: null });
  assert.deepEqual(calls[1].body, { text: "t", expiration_date: null });
});

test("removeAll scopes by any identifier and defaults to the user", async () => {
  const { fetch, calls } = fakeFetch();
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.removeAll({ runId: "s1" });
  const u = new URL(calls[0].url);
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(u.searchParams.get("user_id"), "doug");
  assert.equal(u.searchParams.get("run_id"), "s1");
});

test("entities: list and delete", async () => {
  const { fetch, calls } = fakeFetch([]);
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.listEntities();
  assert.equal(calls[0].url, "http://m/entities");
  await c.deleteEntity("agent", "proj/x");
  assert.equal(calls[1].url, "http://m/entities/agent/proj%2Fx");
  assert.equal(calls[1].options.method, "DELETE");
});

test("get, remove and history hit the memory id routes", async () => {
  const { fetch, calls } = fakeFetch({});
  const c = createClient({ host: "http://m", userId: "doug", fetch });
  await c.get("a/b");
  await c.remove("a/b");
  await c.history("a/b");
  assert.equal(calls[0].url, "http://m/memories/a%2Fb");
  assert.equal(calls[1].url, "http://m/memories/a%2Fb");
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(calls[2].url, "http://m/memories/a%2Fb/history");
});

test("sends X-API-Key when an api key is configured, and not otherwise", async () => {
  const a = fakeFetch();
  await createClient({ host: "http://m", userId: "u", apiKey: "k1", fetch: a.fetch }).search({ query: "q" });
  assert.equal(a.calls[0].options.headers["X-API-Key"], "k1");
  const b = fakeFetch();
  await createClient({ host: "http://m", userId: "u", fetch: b.fetch }).search({ query: "q" });
  assert.equal("X-API-Key" in b.calls[0].options.headers, false);
});

test("non-2xx responses throw with status and body", async () => {
  const fetch = async () => ({ ok: false, status: 400, text: async () => "bad filters" });
  const c = createClient({ host: "http://m", userId: "u", fetch });
  await assert.rejects(() => c.search({ query: "q" }), /mem0 API error 400: bad filters/);
});

test("strips a trailing slash from the host", async () => {
  const { fetch, calls } = fakeFetch();
  await createClient({ host: "http://m/", userId: "u", fetch }).search({ query: "q" });
  assert.equal(calls[0].url, "http://m/search");
});
