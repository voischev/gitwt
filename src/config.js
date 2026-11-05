import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitwtError } from "./process.js";

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitwtError("invalid_config", `${field}: ожидается объект`);
  }
}

export function validateHooks(value) {
  assertObject(value, "hooks");
  for (const [key, commands] of Object.entries(value)) {
    if (!["postCreate", "preRemove"].includes(key) || !Array.isArray(commands)) {
      throw new GitwtError("invalid_config", `hooks.${key}: ожидается список команд`);
    }
    for (const command of commands) {
      const args = Array.isArray(command) ? command : [command];
      if (!args.length || args.some((part) => typeof part !== "string") || !args[0].length) {
        throw new GitwtError("invalid_config", `hooks.${key}: некорректная команда`);
      }
    }
  }
  return { postCreate: [], preRemove: [], ...value };
}

export function expandPath(value, home = os.homedir(), base = process.cwd()) {
  if (value === "~") return home;
  return path.resolve(
    value.startsWith("~/") ? home : base,
    value.startsWith("~/") ? value.slice(2) : value,
  );
}

async function readConfig(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    assertObject(value, file);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new GitwtError("invalid_config", `Не удалось прочитать ${file}: ${error.message}`);
  }
}

export async function loadConfig(root, overrides = {}, home = os.homedir()) {
  assertObject(overrides, "config");
  const config = { remote: "origin", base: "auto", prefix: "", hooks: {} };
  for (const value of [
    await readConfig(path.join(home, ".config/gitwt/config.json")),
    await readConfig(path.join(root, ".gitwt.json")),
    Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  ]) {
    for (const [key, setting] of Object.entries(value)) {
      if (key === "hooks") {
        validateHooks(setting);
      } else if (
        !["remote", "base", "prefix", "worktreeDir"].includes(key) ||
        typeof setting !== "string" ||
        (key !== "prefix" && !setting.length) ||
        (key === "remote" && !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(setting))
      ) {
        throw new GitwtError("invalid_config", `Некорректная настройка: ${key}`);
      }
    }
    const hooks = { ...config.hooks, ...value.hooks };
    Object.assign(config, value, { hooks });
  }
  config.hooks = validateHooks(config.hooks);
  if (config.worktreeDir) config.worktreeDir = expandPath(config.worktreeDir, home, root);
  return config;
}
