# mem0-claude

Claude Code client for a self-hosted [mem0](https://github.com/mem0ai/mem0) memory server — an MCP server exposing memory tools plus session hooks that automatically load and save memories. Point it at your mem0 host and every machine shares the same persistent memory.

> Server deployment (Docker image, CI, nginx, stack) lives in the private **mem0-server** repo. This repo is only the client side that runs on each Claude Code machine.

## Install

One command on any machine (no GitHub auth needed — this repo is public):

```bash
curl -fsSL https://raw.githubusercontent.com/null-is1and/mem0-claude/main/install.sh \
  | MEM0_HOST=https://your-mem0-host MEM0_USER_ID=you bash
```

Then restart Claude Code. Re-run the same command any time to update.

- `MEM0_HOST` (required) — base URL of your mem0 server
- `MEM0_USER_ID` (optional) — memory namespace, defaults to `claude-code`
- append `--project` after `bash` to install into the current project instead of globally

The installer drops the runtime into `~/.claude/mcp-servers/mem0/`, registers the MCP server in `.mcp.json`, and adds the four session hooks to `settings.json`.

### Test it

```
> Search my mem0 memories for "project setup"
> Remember that this project uses PostgreSQL with pgvector
> List all my mem0 memories
```

## What gets installed

**MCP server** (`server.mjs`) — memory tools for Claude Code:

| Tool | Description |
|-|-|
| `add_memory` | Store memories from conversation messages |
| `search_memories` | Semantic search across stored memories |
| `get_memories` | List all memories for a user |
| `get_memory` | Retrieve a specific memory by ID |
| `update_memory` | Update an existing memory |
| `delete_memory` | Delete a specific memory |
| `delete_all_memories` | Delete all memories for a user |
| `memory_history` | Change history for a memory |

**Session hooks** — automate memory at session boundaries:

| Hook | Event | What it does |
|-|-|-|
| `context.mjs` | SessionStart | Searches mem0 for project-relevant memories, injects as `additionalContext` |
| `prompt.mjs` | UserPromptSubmit | Searches memories relevant to each prompt (skips short/command prompts, score >= 0.4) |
| `precompact.mjs` | PreCompact | Summarizes the conversation before compaction so knowledge isn't lost |
| `stop.mjs` | Stop | Extracts decisions, outcomes, and discoveries at session end |

All hooks are non-fatal — if mem0 is unreachable, Claude Code continues normally.

### Deduplication (watermark)

`precompact.mjs` and `stop.mjs` both summarize the transcript, so naively they'd double-write near-identical memories that mem0's own dedup doesn't catch. `watermark.mjs` tracks how many transcript lines each session has already summarized (in `hooks/.state/<session_id>.json`, gitignored); each hook only summarizes the delta since the last summary and advances the mark on a successful write. No overlap, nothing lost, no similarity-threshold guessing.

## CLAUDE.md integration

Add to your `CLAUDE.md` so Claude proactively uses memory during sessions:

```markdown
### Memory (mem0)

Persistent semantic memory via the mem0 MCP server. Hooks inject context at
SessionStart, search per prompt, and save summaries at PreCompact/Stop. Use:
- `search_memories` before asking the user to re-explain prior-session context
- `add_memory` for decisions, architecture insights, debugging lessons,
  preferences, and cross-project knowledge
- `update_memory` when prior context has changed or been invalidated

When in doubt, save — future sessions benefit from over-remembering.
```

## Auto mode / permissions

Claude Code auto-mode and permission rulesets are per-deployment infrastructure config (they reference your own hosts and services), so they aren't shipped in this public repo. Keep them in a private repo and apply them per machine from there.

## Manual install

If you'd rather not pipe to bash, clone and run the Node installer directly:

```bash
git clone https://github.com/null-is1and/mem0-claude ~/.claude/mcp-servers/mem0
cd ~/.claude/mcp-servers/mem0 && npm install
MEM0_HOST=https://your-mem0-host MEM0_USER_ID=you node install.mjs --global
```
