# gitwt

Agent-ready CLI + Node API for Git worktrees. Create an isolated checkout for
each task or agent, inspect it, and remove it explicitly. gitwt manages
worktrees only; it does not orchestrate agents.

Requires Node.js 22.14+ and Git. No runtime dependencies.

## Install

`npm install -g @voischev/gitwt` installs the CLI;
`npm install @voischev/gitwt` adds the library.

## Agent workflow

Run `gitwt --skill` to print a ready-to-paste prompt for Codex, Claude Code, or
another agent with terminal access. Paste it into the client's instructions or
ask the agent to run `gitwt --skill` and follow the output. It only prints text;
it does not configure the client or change files. `--skill --json` returns the
prompt in `data.prompt`.

1. Run `gitwt add <branch> --base <remote-branch> --json`.
2. Read `data.worktreePath` and work there.
3. On success with warnings, keep the worktree and check `data.warnings`.
4. Use `gitwt list --status --json` to inspect live state.
5. Remove explicitly with `gitwt remove <branch> --json`.

For parallel agents, use one worktree per agent.

## CLI

Human-readable by default:

```sh
gitwt add feature/login --base main
gitwt list --status
gitwt cd feature/login
gitwt remove feature/login
```

`add` creates a branch from a freshly fetched remote base and verifies the
checkout. Use `--from <ref>` for a local ref or commit, `--path` for an exact
destination, `--dir` for a base directory, and `--no-hooks` to disable hooks.
`cd` prints only the worktree path for shell use. `list` marks the current
worktree with `*`.

## Machine output

`--json` and `--porcelain` use the same envelope:

```json
{
  "ok": true,
  "command": "add",
  "data": { "branch": "feature/login", "worktreePath": "/path", "head": "sha", "warnings": [] }
}
```

Failures use the same envelope with `"ok": false`, `"command"`, and an `"error"`
object containing `"code"`, `"message"`, and `"details"`; they go to stderr
with exit 1. Successful writes, including `warnings` from a failed `postCreate`,
stay in `data`. In human mode warnings go to stderr. Never parse human logs.

## JavaScript API

```js
import { createWorktree, listWorktrees, removeWorktree } from "@voischev/gitwt";

const created = await createWorktree(process.cwd(), {
  branch: "feature/login",
  config: { base: "main" },
});

const worktrees = await listWorktrees(process.cwd(), { status: true });
await removeWorktree(process.cwd(), "feature/login");
```

`listWorktrees` always includes `dirty`, `ahead`, and `behind`. They are `null`
when live status was not requested or an upstream comparison is unavailable;
a successful live check sets `dirty` to a boolean.

## Configuration

Project settings live in `.gitwt.json`; global defaults live in
`~/.config/gitwt/config.json`. Use plain JSON. To migrate, rename `.jsonc` files
to `.json` and remove comments and trailing commas.

```json
{
  "remote": "origin",
  "base": "auto",
  "prefix": "",
  "worktreeDir": "~/gitwt",
  "hooks": { "postCreate": [["npm", "ci"]], "preRemove": ["git status --short"] }
}
```

`remote`, `base`, `prefix`, `worktreeDir`, and `hooks` are optional. Hooks run
after creation or before removal. Each worktree keeps its own
`gitwt-hooks.json` snapshot, so later configuration changes do not affect an
existing checkout.

## Integrations

`opencode-gitwt` exposes gitwt as tools inside OpenCode conversations:
https://github.com/voischev/opencode-gitwt
