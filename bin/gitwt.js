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
  "Options: --json, --path <path>, --dir <dir>, --remote <name>, --prefix <prefix>, --no-hooks",
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
      },
    });
  } catch (error) {
    throw new GitwtError("invalid_arguments", `Некорректные аргументы: ${error.message}`);
  }
  const { values, positionals } = parsed;
  const [command, target, ...extra] = positionals;
  currentCommand = command ?? null;
  if (!command || values.help) {
    if (machine) {
      process.stdout.write(`${JSON.stringify({ ok: true, command: "help", data: { usage } })}\n`);
    } else {
      process.stdout.write(`${usage}\n`);
    }
    return;
  }
  if (!["add", "list", "cd", "hooks", "remove", "config"].includes(command)) {
    throw new GitwtError("invalid_command", `Неизвестная команда: ${command}`);
  }
  if (extra.length || (!["add", "cd", "remove", "hooks"].includes(command) && target)) {
    throw new GitwtError("invalid_arguments", "Лишние позиционные аргументы");
  }
  if (["add", "cd", "remove", "hooks"].includes(command) && !target) {
    throw new GitwtError("missing_argument", `Укажите ветку или путь для ${command}`);
  }
  if (values["no-hooks"] && command !== "add") {
    throw new GitwtError("invalid_arguments", "--no-hooks допустим только при создании worktree");
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
