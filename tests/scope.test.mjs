import { test } from "node:test";
import assert from "node:assert/strict";
import { projectAgentId, expirationDate, summaryTtlDays } from "../lib/scope.mjs";

test("projectAgentId derives a stable per-project agent id from the cwd basename", () => {
  assert.equal(projectAgentId("/home/x/claude/mem0-claude"), "project:mem0-claude");
  assert.equal(projectAgentId("/home/x/claude/mem0-claude/"), "project:mem0-claude");
});

test("projectAgentId falls back when cwd is missing", () => {
  assert.equal(projectAgentId(""), "project:unknown");
  assert.equal(projectAgentId(undefined), "project:unknown");
});

test("expirationDate returns YYYY-MM-DD `days` after `now` in UTC", () => {
  const now = new Date("2026-09-19T23:30:00Z");
  assert.equal(expirationDate(60, now), "2026-11-18");
  assert.equal(expirationDate(1, now), "2026-09-20");
});

test("expirationDate is undefined when days is 0 or invalid (expiry disabled)", () => {
  assert.equal(expirationDate(0, new Date()), undefined);
  assert.equal(expirationDate(-3, new Date()), undefined);
  assert.equal(expirationDate(NaN, new Date()), undefined);
});

test("summaryTtlDays reads MEM0_SUMMARY_TTL_DAYS with a 60-day default", () => {
  assert.equal(summaryTtlDays({}), 60);
  assert.equal(summaryTtlDays({ MEM0_SUMMARY_TTL_DAYS: "30" }), 30);
  assert.equal(summaryTtlDays({ MEM0_SUMMARY_TTL_DAYS: "0" }), 0);
  assert.equal(summaryTtlDays({ MEM0_SUMMARY_TTL_DAYS: "abc" }), 60);
});
