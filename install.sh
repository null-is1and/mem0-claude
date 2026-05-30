#!/usr/bin/env bash
# One-command installer for the mem0 Claude Code client (MCP server + hooks).
#
#   curl -fsSL https://raw.githubusercontent.com/null-is1and/mem0-claude/main/install.sh \
#     | MEM0_HOST=https://your-mem0-host MEM0_USER_ID=you bash
#
# Re-run any time to update to the latest version.
#
# Env vars:
#   MEM0_HOST     (required) base URL of your mem0 server
#   MEM0_USER_ID  (optional) memory namespace, default "claude-code"
# Args:
#   --project     install into the current project (.mcp.json / .claude) instead of globally

set -euo pipefail

REPO="null-is1and/mem0-claude"
BRANCH="${MEM0_CLAUDE_BRANCH:-main}"
DEST="${HOME}/.claude/mcp-servers/mem0"

: "${MEM0_HOST:?Set MEM0_HOST=https://your-mem0-host before running}"
MEM0_USER_ID="${MEM0_USER_ID:-claude-code}"

SCOPE="--global"
[ "${1:-}" = "--project" ] && SCOPE=""

echo "  [mem0] Installing client to ${DEST}"
mkdir -p "${DEST}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" \
  | tar xz -C "${TMP}" --strip-components=1

# Copy runtime files (MCP server, installer, hooks) into place.
cp -R "${TMP}/server.mjs" "${TMP}/install.mjs" "${TMP}/package.json" "${TMP}/hooks" "${DEST}/"

( cd "${DEST}" && npm install --silent --no-audit --no-fund )

MEM0_HOST="${MEM0_HOST}" MEM0_USER_ID="${MEM0_USER_ID}" node "${DEST}/install.mjs" ${SCOPE}

echo "  [mem0] Done. Restart Claude Code to activate."
