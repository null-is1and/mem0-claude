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

### Extraction quality (client-side distill)

mem0's `/memories` add endpoint runs its **own** extraction LLM over whatever you POST. Instructions placed in the message *content* don't steer anything — mem0 treats them as text to mine, so session narrative ("user asked…", "ran /compact"), transient state ("76 entries"), and even your own instruction text leak back in as memories. mem0 does expose a **`prompt`** field that overrides its extractor instructions, but it wraps your prompt in its own scaffolding and the steer is only partial — in practice ~25% of stored entries are still narrative.

The hooks therefore prefer **client-side extraction**: when `MEM0_LLM_KEY` is set, each summarizer hook calls an LLM directly (LiteLLM-compatible `/chat/completions`), distills the conversation into a JSON array of durable facts using the INCLUDE/EXCLUDE rules in `hooks/extraction.mjs`, and stores those facts **verbatim** with `infer:false` — so mem0 never re-extracts and nothing leaks. Because our prompt is the only instruction the model sees, the EXCLUDE rules are obeyed reliably.

Configure via env (baked into the hook commands by `install.mjs`):
- `MEM0_LLM_KEY` — API key for the extraction LLM. **Without it the hooks fall back** to mem0's server-side extractor steered by the `prompt` field (weaker, but no credential needed — keeps un-keyed hosts working).
- `MEM0_LLM_MODEL` — chat model (default `gpt-5.4-mini`).
- `MEM0_LLM_BASE` — OpenAI-compatible base URL for the extraction LLM (e.g. `https://your-litellm-host/v1`). Required for the client-side path; if unset, the hooks fall back to mem0's server-side extractor.

Install with the key and endpoint: `… MEM0_LLM_KEY=sk-… MEM0_LLM_BASE=https://your-litellm-host/v1 bash` (or `--llm-key=sk-…` / `--llm-base=…`). Use a model that follows instructions tightly and supports JSON output; a dedicated low-rate key scoped to just that model is recommended.

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

## Known limitations

- **`get_memories` returns at most 20 results.** The self-hosted mem0 API caps the `/memories` endpoint at 20 items with no pagination support. Use `search_memories` instead — it accepts a `limit` parameter (e.g. `limit: 100`) and returns results ranked by relevance, making it both more complete and more useful for large stores.

## Manual install

If you'd rather not pipe to bash, clone and run the Node installer directly:

```bash
git clone https://github.com/null-is1and/mem0-claude ~/.claude/mcp-servers/mem0
cd ~/.claude/mcp-servers/mem0 && npm install
MEM0_HOST=https://your-mem0-host MEM0_USER_ID=you node install.mjs --global
```
