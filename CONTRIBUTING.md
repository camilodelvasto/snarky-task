# Contributing

## Setup

```bash
npm install      # also rebuilds native modules (node-pty, better-sqlite3) for Electron
npm run dev      # launch the app with hot reload
```

Requires Node.js 20+ and the [Claude Code CLI](https://claude.com/claude-code) for the full experience (the app works without it, but the terminal won't auto-start Claude).

## Before opening a PR

```bash
npm run typecheck
npm run lint
npx vitest run
```

Tests live in `src/main/__tests__/`. New logic in the main process (intent resolution, pane state, persona) should come with a test; UI changes are verified by running the app.

## Project layout

See the Architecture section in the [README](README.md). The short version: `src/main/` is the Electron main process (MCP server in `src/main/mcp/`), `src/renderer/` is the React UI, and `projects/` + `templates/` are the user-facing extension points.
