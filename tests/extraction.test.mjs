import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFacts, groupByCategory, CATEGORIES, summarizeAndStore, EXTRACTION_PROMPT } from "../hooks/extraction.mjs";

test("CATEGORIES matches upstream's five memory categories", () => {
  assert.deepEqual(CATEGORIES, [
    "project_knowledge", "decisions_and_constraints", "workflows", "problems_and_fixes", "results",
  ]);
});

test("parseFacts accepts categorized objects and normalizes to {text, category}", () => {
  const out = parseFacts(JSON.stringify({ facts: [
    { text: "Uses pgvector", category: "project_knowledge" },
    { text: "Never use /configure", category: "problems_and_fixes" },
  ] }));
  assert.deepEqual(out, [
    { text: "Uses pgvector", category: "project_knowledge" },
    { text: "Never use /configure", category: "problems_and_fixes" },
  ]);
});

test("parseFacts still accepts bare strings and defaults their category", () => {
  const out = parseFacts('{"facts": ["a fact", "  ", 42]}');
  assert.deepEqual(out, [{ text: "a fact", category: "project_knowledge" }]);
});

test("parseFacts maps an unknown category to the default", () => {
  const out = parseFacts('{"facts": [{"text": "x", "category": "gossip"}]}');
  assert.equal(out[0].category, "project_knowledge");
});

test("parseFacts tolerates prose around the JSON and a bare array", () => {
  assert.equal(parseFacts('Sure! {"facts": ["one"]} done')[0].text, "one");
  assert.equal(parseFacts('["two"]')[0].text, "two");
  assert.deepEqual(parseFacts("nothing here"), []);
  assert.deepEqual(parseFacts(""), []);
});

test("parseFacts caps count and length", () => {
  const many = Array.from({ length: 20 }, (_, i) => "f".repeat(600) + i);
  const out = parseFacts(JSON.stringify({ facts: many }));
  assert.equal(out.length, 12);
  assert.equal(out[0].text.length, 500);
});

test("groupByCategory buckets facts preserving order", () => {
  const groups = groupByCategory([
    { text: "a", category: "workflows" },
    { text: "b", category: "results" },
    { text: "c", category: "workflows" },
  ]);
  assert.deepEqual(groups, { workflows: ["a", "c"], results: ["b"] });
});

test("summarizeAndStore writes one add per category with scope, expiry and category metadata", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/chat/completions")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [
        { text: "a", category: "workflows" }, { text: "b", category: "results" }, { text: "c", category: "workflows" },
      ] }) } }] }) };
    }
    return { ok: true, json: async () => ({ results: [] }), text: async () => "" };
  };
  const result = await summarizeAndStore({
    host: "http://m", llmKey: "k", llmBase: "http://llm/v1", fetch,
    messages: [{ role: "user", content: "hi there" }],
    userId: "doug", agentId: "project:p", runId: "sess-1", expirationDate: "2026-11-18",
    metadata: { type: "session_summary", project: "p", session_id: "sess-1" },
  });
  assert.deepEqual(result, { ok: true, stored: 3 });
  const adds = calls.filter((c) => c.url === "http://m/memories");
  assert.equal(adds.length, 2);
  const wf = adds.find((c) => c.body.metadata.category === "workflows");
  assert.deepEqual(wf.body, {
    messages: [{ role: "user", content: "a" }, { role: "user", content: "c" }],
    user_id: "doug", agent_id: "project:p", run_id: "sess-1", infer: false, expiration_date: "2026-11-18",
    metadata: { type: "session_summary", project: "p", session_id: "sess-1", category: "workflows" },
  });
});

test("summarizeAndStore fallback path passes scope, expiry and prompt to the server-side extractor", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({}), text: async () => "" };
  };
  const messages = [{ role: "user", content: "hi there" }];
  const result = await summarizeAndStore({
    host: "http://m", fetch, messages, userId: "doug", agentId: "project:p", runId: "s", expirationDate: "2026-11-18",
    metadata: { type: "session_summary" },
  });
  assert.deepEqual(result, { ok: true, stored: null });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    messages, user_id: "doug", agent_id: "project:p", run_id: "s", expiration_date: "2026-11-18",
    prompt: EXTRACTION_PROMPT, metadata: { type: "session_summary" },
  });
});

test("summarizeAndStore sends the api key header when configured", async () => {
  let headers;
  const fetch = async (url, options = {}) => { headers = options.headers; return { ok: true, json: async () => ({}), text: async () => "" }; };
  await summarizeAndStore({ host: "http://m", apiKey: "k9", fetch, messages: [], userId: "u", metadata: {} });
  assert.equal(headers["X-API-Key"], "k9");
});

test("extraction prompt asks for categorized facts", () => {
  for (const c of CATEGORIES) assert.match(EXTRACTION_PROMPT, new RegExp(c));
});
