import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALL = resolve(import.meta.dirname, "../install.mjs");

function run(env, args = ["--global"]) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [INSTALL, ...args], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => done({ code, out }));
  });
}
const readJson = async (p) => JSON.parse(await readFile(p, "utf-8"));

test("global install registers the MCP server in ~/.claude.json (the file Claude Code actually reads)", async () => {
  const home = await mkdtemp(join(tmpdir(), "mem0-home-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }));
  const { code, out } = await run({ HOME: home, MEM0_HOST: "http://m", MEM0_USER_ID: "doug", MEM0_API_KEY: "k1", MEM0_SUMMARY_TTL_DAYS: "30" });
  assert.equal(code, 0, out);
  const cfg = await readJson(join(home, ".claude.json"));
  assert.equal(cfg.numStartups, 3, "unrelated keys preserved");
  assert.ok(cfg.mcpServers.other, "other servers preserved");
  assert.deepEqual(cfg.mcpServers.mem0.env, { MEM0_HOST: "http://m", MEM0_USER_ID: "doug", MEM0_API_KEY: "k1" });
  assert.match(cfg.mcpServers.mem0.args[0], /server\.mjs$/);
});

test("hooks get the api key, and the summary hooks get the TTL", async () => {
  const home = await mkdtemp(join(tmpdir(), "mem0-home-"));
  const { code, out } = await run({ HOME: home, MEM0_HOST: "http://m", MEM0_USER_ID: "doug", MEM0_API_KEY: "k1", MEM0_SUMMARY_TTL_DAYS: "30" });
  assert.equal(code, 0, out);
  const settings = await readJson(join(home, ".claude", "settings.json"));
  const cmd = (event) => settings.hooks[event][0].hooks[0].command;
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"]) {
    assert.match(cmd(ev), /MEM0_API_KEY=k1 /, ev);
    assert.match(cmd(ev), /MEM0_HOST=http:\/\/m /, ev);
  }
  assert.match(cmd("Stop"), /MEM0_SUMMARY_TTL_DAYS=30 /);
  assert.match(cmd("PreCompact"), /MEM0_SUMMARY_TTL_DAYS=30 /);
  assert.doesNotMatch(cmd("SessionStart"), /MEM0_SUMMARY_TTL_DAYS/);
});

test("re-running the installer updates the existing MCP entry instead of skipping it", async () => {
  const home = await mkdtemp(join(tmpdir(), "mem0-home-"));
  await run({ HOME: home, MEM0_HOST: "http://old", MEM0_USER_ID: "doug" });
  const { code } = await run({ HOME: home, MEM0_HOST: "http://new", MEM0_USER_ID: "doug", MEM0_API_KEY: "k2" });
  assert.equal(code, 0);
  const cfg = await readJson(join(home, ".claude.json"));
  assert.deepEqual(cfg.mcpServers.mem0.env, { MEM0_HOST: "http://new", MEM0_USER_ID: "doug", MEM0_API_KEY: "k2" });
  const settings = await readJson(join(home, ".claude", "settings.json"));
  assert.equal(settings.hooks.Stop.length, 1, "hook not duplicated");
});

test("install.sh ships the lib/ directory the server and hooks import from", async () => {
  const sh = await readFile(resolve(import.meta.dirname, "../install.sh"), "utf-8");
  assert.match(sh, /\$\{TMP\}\/lib/);
});
