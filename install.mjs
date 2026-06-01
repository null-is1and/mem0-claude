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

  const envPrefix =
    `MEM0_HOST=${mem0Host} MEM0_USER_ID=${mem0User}` +
    (mem0LlmKey ? ` MEM0_LLM_KEY=${mem0LlmKey}` : "");

  const hookDefs = [
    { event: "SessionStart", file: "context.mjs", timeout: 15 },
    { event: "UserPromptSubmit", file: "prompt.mjs", timeout: 5 },
    { event: "PreCompact", file: "precompact.mjs", timeout: 20 },
    { event: "Stop", file: "stop.mjs", timeout: 30 },
  ];

  for (const def of hookDefs) {
    if (!settings.hooks[def.event]) settings.hooks[def.event] = [];

    const exists = settings.hooks[def.event].some((e) =>
      e.hooks?.some((h) => h.command?.includes(def.file))
    );

    if (!exists) {
      settings.hooks[def.event].push({
        matcher: "",
        hooks: [{
          type: "command",
          command: `${envPrefix} node ${resolve(hooksDir, def.file)}`,
          timeout: def.timeout,
        }],
      });
      log(`${def.event} hook added`);
    } else {
      log(`${def.event} hook already exists`);
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
