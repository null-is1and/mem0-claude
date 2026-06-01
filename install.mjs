#!/usr/bin/env node
// Installer for mem0 MCP server + Claude Code hooks

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flags = new Set(args);
const isGlobal = flags.has("--global") || flags.has("-g");
const skipHooks = flags.has("--no-hooks");
const skipMcp = flags.has("--no-mcp");
const mem0Host = process.env.MEM0_HOST || args.find((a) => a.startsWith("--host="))?.split("=")[1];
const mem0User = process.env.MEM0_USER_ID || args.find((a) => a.startsWith("--user="))?.split("=")[1] || "claude-code";
// Optional: a LiteLLM key enables client-side fact extraction in the hooks.
// Without it the hooks fall back to mem0's server-side extractor.
const mem0LlmKey = process.env.MEM0_LLM_KEY || args.find((a) => a.startsWith("--llm-key="))?.split("=")[1];
// Optional: the LLM endpoint for client-side extraction. No internal host is
// baked into this public repo, so the endpoint is supplied here or via env.
const mem0LlmBase = process.env.MEM0_LLM_BASE || args.find((a) => a.startsWith("--llm-base="))?.split("=")[1];

if (!mem0Host) {
  console.error("  [mem0] MEM0_HOST is required (env var or --host=https://your-mem0-host).");
  process.exit(1);
}

const home = homedir();
const claudeDir = resolve(home, ".claude");
const hooksDir = resolve(dirname(new URL(import.meta.url).pathname), "hooks");

function log(msg) {
  console.log(`  [mem0] ${msg}`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

async function installMcp() {
  const mcpPath = isGlobal
    ? resolve(claudeDir, ".mcp.json")
    : resolve(process.cwd(), ".mcp.json");

  const mcp = await readJson(mcpPath);
  if (!mcp.mcpServers) mcp.mcpServers = {};

  if (mcp.mcpServers.mem0) {
    log(`MCP server already configured in ${mcpPath}`);
    return;
  }

  mcp.mcpServers.mem0 = {
    command: "node",
    args: [resolve(hooksDir, "..", "server.mjs")],
    env: {
      MEM0_HOST: mem0Host,
      MEM0_USER_ID: mem0User,
    },
  };

  await writeJson(mcpPath, mcp);
  log(`MCP server added to ${mcpPath}`);
}

async function installHooks() {
  const settingsPath = isGlobal
    ? resolve(claudeDir, "settings.json")
    : resolve(process.cwd(), ".claude", "settings.json");

  const settings = await readJson(settingsPath);
  if (!settings.hooks) settings.hooks = {};

  const baseEnv = { MEM0_HOST: mem0Host, MEM0_USER_ID: mem0User };

  const hookDefs = [
    { event: "SessionStart", file: "context.mjs", timeout: 15 },
    { event: "UserPromptSubmit", file: "prompt.mjs", timeout: 5 },
    { event: "PreCompact", file: "precompact.mjs", timeout: 20, llm: true },
    { event: "Stop", file: "stop.mjs", timeout: 30, llm: true },
  ];

  // Parse the leading "KEY=val …" tokens of a hook command (everything before `node`).
  const parseEnv = (command) => {
    const env = {};
    for (const tok of (command || "").split(/\s+/)) {
      if (tok === "node") break;
      const i = tok.indexOf("=");
      if (i > 0) env[tok.slice(0, i)] = tok.slice(i + 1);
    }
    return env;
  };
  const findHook = (arr, file) => {
    for (const e of arr) for (const h of e.hooks || []) if (h.command?.includes(file)) return h;
    return null;
  };

  for (const def of hookDefs) {
    if (!settings.hooks[def.event]) settings.hooks[def.event] = [];
    const existing = findHook(settings.hooks[def.event], def.file);

    // Merge env: preserve whatever is already on the command (e.g. a MEM0_LLM_KEY
    // distributed via claude-config) and overlay the values this install owns.
    // A re-install thus updates host/user/path/timeout idempotently without
    // stripping a distributed key. Only sets the key itself when install is given
    // one (--llm-key= / MEM0_LLM_KEY) for an extraction hook.
    const env = { ...(existing ? parseEnv(existing.command) : {}), ...baseEnv };
    if (def.llm && mem0LlmKey) env.MEM0_LLM_KEY = mem0LlmKey;
    if (def.llm && mem0LlmBase) env.MEM0_LLM_BASE = mem0LlmBase;

    const prefix = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
    const command = `${prefix} node ${resolve(hooksDir, def.file)}`;

    if (existing) {
      existing.command = command;
      existing.timeout = def.timeout;
      log(`${def.event} hook updated`);
    } else {
      settings.hooks[def.event].push({
        matcher: "",
        hooks: [{ type: "command", command, timeout: def.timeout }],
      });
      log(`${def.event} hook added`);
    }
  }

  await writeJson(settingsPath, settings);
  log(`Hooks saved to ${settingsPath}`);
}

async function main() {
  console.log("\n  mem0 Claude Code installer\n");
  console.log(`  Host:   ${mem0Host}`);
  console.log(`  User:   ${mem0User}`);
  console.log(`  Scope:  ${isGlobal ? "global (~/.claude)" : "project (.claude)"}\n`);

  if (!skipMcp) await installMcp();
  if (!skipHooks) await installHooks();

  console.log("\n  Done. Restart Claude Code to activate.\n");
}

main().catch((e) => {
  console.error(`  [mem0] Error: ${e.message}`);
  process.exit(1);
});
