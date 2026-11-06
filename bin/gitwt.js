#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  createWorktree,
  GitwtError,
  inspectHooks,
  listWorktrees,
  loadConfig,
  removeWorktree,
  repository,
  resolveWorktree,
} from "../src/index.js";

const usage = [
  "gitwt add <branch> [--base <branch> | --from <ref>]",
  "gitwt list [--status]",
  "gitwt cd|hooks <branch|path>",
  "gitwt remove <branch|path> [--force] [--keep-branch]",
  "gitwt config",
  "gitwt --skill",
  "Options: --json, --path <path>, --dir <dir>, --remote <name>, --prefix <prefix>, --no-hooks",
].join("\n");
const skill = [
  "# Git worktrees with gitwt",
  "",
  "Use gitwt when a task needs an isolated Git checkout or parallel work. Use one worktree and a unique branch per task or agent.",
  "The CLI is installed with `npm install -g @voischev/gitwt`. Run `gitwt --help` for options.",
  "",
  "1. From the repository, inspect existing copies with `gitwt list --status --json`. Coordinate before reusing another agent's worktree.",
  "2. Create a new branch: `gitwt add <branch> --base <remote-branch> --json`. Choose the intended base; use `--from <verified-ref-or-commit>` for a local starting point instead.",
  "3. Read `data.worktreePath`, `data.branch`, and `data.head`. Check `data.warnings` before continuing: a failed setup hook leaves the worktree in place.",
  "4. Read the checkout's AGENTS.md and project instructions. Use worktreePath as cwd for every command and absolute paths inside it for file operations. Keep the current conversation.",
  "5. Resume with `gitwt cd <branch-or-path> --json`; this returns a path, it does not change your shell or session directory. Inspect live state with `gitwt list --status --json`.",
  "6. Keep worktrees when pausing or handing off. Remove only when explicitly requested and no longer in use: `gitwt remove <branch-or-path> --json`. Use `--keep-branch` to preserve the branch. Use `--force` only with explicit permission to discard local changes; it does not bypass a failing preRemove hook.",
  "",
  "Machine output: stdout contains one JSON object `{ok:true,command,data}`. Failures exit nonzero and write `{ok:false,command,error:{code,message,details}}` to stderr. Never parse human logs. A null status means unknown, not clean or zero.",
  "A failed creation may leave a worktree: inspect the reported path before retrying. Do not automatically reset, delete, commit, or push. A clean or merged branch does not prove another agent is finished.",
  "Project configuration: `.gitwt.json`; global defaults: `~/.config/gitwt/config.json`. Hooks are optional and saved per worktree; use `--no-hooks` at creation only when intentionally disabling them.",
].join("\n");
const machine = process.argv.includes("--json") || process.argv.includes("--porcelain");
let currentCommand = null;

function statusText(item) {
  if ("prunable" in item) return "недоступен";
  if (item.bare) return "bare";
  if (item.dirty === null) return "статус неизвестен";
  const parts = [item.dirty ? "изменения" : "чисто"];
  if (item.ahead !== null) parts.push(`ahead ${item.ahead}`);
  if (item.behind !== null) parts.push(`behind ${item.behind}`);
  return parts.join(", ");
}

function printHuman(command, result) {
  if (command === "cd") {
    process.stdout.write(`${result.worktreePath}\n`);
    return;
  }
  if (command === "add") {
    process.stdout.write(
      `Worktree создан.\nВетка: ${result.branch}\nПуть: ${result.worktreePath}\nHEAD: ${result.head}\n`,
    );
    return;
  }
  if (command === "remove") {
    process.stdout.write(
      `Worktree удалён.\nВетка: ${result.branch ?? "неизвестна"}\n` +
        `Путь: ${result.worktreePath}\nВетка удалена: ${result.branchDeleted ? "да" : "нет"}\n`,
    );
    return;
  }
  if (command === "list") {
    if (!result.length) {
      process.stdout.write("Worktree не найдены.\n");
      return;
    }
    for (const item of result) {
      process.stdout.write(
        `${item.current ? "*" : " "} ${item.branch ?? "(detached)"}  ${item.worktreePath}  ${item.head ?? "неизвестен"}  ${statusText(item)}\n`,
      );
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        porcelain: { type: "boolean" },
        status: { type: "boolean" },
        remote: { type: "string" },
        base: { type: "string" },
        from: { type: "string" },
        prefix: { type: "string" },
        path: { type: "string" },
        dir: { type: "string" },
        "no-hooks": { type: "boolean" },
        force: { type: "boolean" },
        "keep-branch": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        skill: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new GitwtError("invalid_arguments", `Некорректные аргументы: ${error.message}`);
  }
  const { values, positionals } = parsed;
  const [command, target, ...extra] = positionals;
  currentCommand = values.skill ? "skill" : (command ?? null);
  if ((!command && !values.skill) || values.help) {
    if (machine) {
      process.stdout.write(`${JSON.stringify({ ok: true, command: "help", data: { usage } })}\n`);
    } else {
      process.stdout.write(`${usage}\n`);
    }
    return;
  }
  const allowed = {
    add: ["base", "from", "path", "dir", "remote", "prefix", "no-hooks"],
    list: ["status"],
    cd: [],
    hooks: [],
    remove: ["force", "keep-branch"],
    config: ["base", "dir", "remote", "prefix"],
    skill: [],
  };
  if (!Object.hasOwn(allowed, currentCommand) || (command === "skill" && !values.skill)) {
    throw new GitwtError("invalid_command", `Неизвестная команда: ${command}`);
  }
  for (const option of Object.keys(values)) {
    if (
      !["json", "porcelain", "help", "skill"].includes(option) &&
      !allowed[currentCommand].includes(option)
    ) {
      throw new GitwtError(
        "invalid_arguments",
        `Параметр --${option} недопустим для ${currentCommand}`,
      );
    }
  }
  for (const [first, second] of [
    ["base", "from"],
    ["path", "dir"],
  ]) {
    if (values[first] !== undefined && values[second] !== undefined) {
      throw new GitwtError(
        "invalid_arguments",
        `Нельзя одновременно использовать --${first} и --${second}`,
      );
    }
  }
  if (values.skill) {
    if (positionals.length)
      throw new GitwtError("invalid_arguments", "Используйте --skill без команды");
    process.stdout.write(
      machine
        ? `${JSON.stringify({ ok: true, command: "skill", data: { prompt: skill } })}\n`
        : `${skill}\n`,
    );
    return;
  }
  if (extra.length || (!["add", "cd", "remove", "hooks"].includes(command) && target)) {
    throw new GitwtError("invalid_arguments", "Лишние позиционные аргументы");
  }
  if (["add", "cd", "remove", "hooks"].includes(command) && !target) {
    throw new GitwtError("missing_argument", `Укажите ветку или путь для ${command}`);
  }
  const cwd = process.cwd();
  const config = {
    remote: values.remote,
    base: values.base,
    prefix: values.prefix,
    worktreeDir: values.dir,
  };
  let result;
  switch (command) {
    case "add":
      result = await createWorktree(cwd, {
        branch: target,
        path: values.path,
        from: values.from,
        noHooks: values["no-hooks"],
        config,
      });
      break;
    case "list":
      result = await listWorktrees(cwd, { status: values.status });
      break;
    case "cd":
      result = await resolveWorktree(cwd, target);
      break;
    case "hooks":
      result = await inspectHooks(cwd, target);
      break;
    case "remove":
      result = await removeWorktree(cwd, target, {
        force: values.force,
        deleteBranch: !values["keep-branch"],
      });
      break;
    case "config":
      result = await loadConfig((await repository(cwd)).root, config);
      break;
  }
  if (machine) {
    process.stdout.write(`${JSON.stringify({ ok: true, command, data: result })}\n`);
    return;
  }
  printHuman(command, result);
  for (const warning of result.warnings ?? []) {
    process.stderr.write(`Предупреждение: ${warning}\n`);
  }
}

main().catch((error) => {
  const code = error instanceof GitwtError ? error.code : (error.code ?? "unexpected_error");
  if (machine) {
    const envelope = {
      ok: false,
      command: currentCommand,
      error: {
        code,
        message: error.message,
        details: error.details ?? {},
      },
    };
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(`Ошибка: ${error.message}\n`);
  }
  process.exitCode = 1;
});
