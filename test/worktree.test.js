import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWorktree,
  inspectHooks,
  listWorktrees,
  loadConfig,
  removeWorktree,
  resolveWorktree,
} from "../src/index.js";

const bin = fileURLToPath(new URL("../bin/gitwt.js", import.meta.url));
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Тест",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Тест",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
};
const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    env: identity,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const command = (script) => [process.execPath, "-e", script];
const cli = (args, cwd, env = identity) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8" });

async function fixture(t) {
  const base = path.join(os.tmpdir(), "gitwt");
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, "gitwt-core-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "project");
  const remote = path.join(root, "remote.git");
  const home = path.join(root, "home");
  await mkdir(home);
  git(["init", "--bare", "--initial-branch=main", remote], root);
  git(["clone", remote, repo], root);
  await writeFile(path.join(repo, "README.md"), "Начало\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "Начало"], repo);
  git(["push", "origin", "main"], repo);
  return { root, repo, home, remote };
}

test("создаёт новую ветку от свежей remote-базы, не меняя грязный исходный checkout", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other");
  git(["clone", f.remote, other], f.root);
  await writeFile(path.join(other, "remote.txt"), "Свежий коммит");
  git(["add", "."], other);
  git(["commit", "-m", "Обновление"], other);
  git(["push", "origin", "main"], other);
  git(["switch", "-c", "current-task"], f.repo);
  await writeFile(path.join(f.repo, "unsaved.txt"), "Исходные изменения");
  const created = await createWorktree(f.repo, { branch: "feature/Login", home: f.home });
  assert.equal(created.head, git(["rev-parse", "HEAD"], other));
  assert.equal(git(["branch", "--show-current"], created.worktreePath), "feature/Login");
  assert.equal(git(["branch", "--show-current"], f.repo), "current-task");
  assert.equal(await readFile(path.join(f.repo, "unsaved.txt"), "utf8"), "Исходные изменения");
  assert.equal(git(["status", "--porcelain"], created.worktreePath), "");
  assert.throws(() => git(["rev-parse", "@{upstream}"], created.worktreePath));
});

test("локальная база работает без remote; существующая ветка и неверный prefix отклоняются", async (t) => {
  const f = await fixture(t);
  git(["remote", "remove", "origin"], f.repo);
  const created = await createWorktree(f.repo, { branch: "local", from: "HEAD", home: f.home });
  assert.equal(created.head, git(["rev-parse", "HEAD"], f.repo));
  await assert.rejects(createWorktree(f.repo, { branch: "local", from: "HEAD", home: f.home }), {
    code: "branch_exists",
  });
  await assert.rejects(
    createWorktree(f.repo, {
      branch: "bad",
      from: "HEAD",
      home: f.home,
      config: { prefix: "../" },
    }),
    { code: "invalid_name" },
  );
});

test("список и поиск используют реестр Git, включая вручную созданные worktree", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'my "worktree"');
  git(["worktree", "add", "-b", "manual", target], f.repo);
  assert.equal((await listWorktrees(f.repo)).length, 2);
  assert.equal((await resolveWorktree(f.repo, "manual")).worktreePath, target);
  assert.equal((await resolveWorktree(f.repo, target)).branch, "manual");
  assert.deepEqual(await inspectHooks(f.repo, "manual"), {
    worktreePath: target,
    snapshot: "absent",
    postCreate: "unknown",
    preRemove: "unknown",
  });
  await assert.rejects(resolveWorktree(f.repo, "missing"), { code: "worktree_missing" });
});

test("конфиг объединяет global/project/аргументы и сохраняет независимые списки хуков", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, ".config/gitwt"), { recursive: true });
  await writeFile(
    path.join(f.home, ".config/gitwt/config.json"),
    '{"prefix":"global/","hooks":{"postCreate":["true"]}}',
  );
  await writeFile(
    path.join(f.repo, ".gitwt.json"),
    '{"prefix":"project/","hooks":{"preRemove":["true"]}}',
  );
  const config = await loadConfig(f.repo, { prefix: "cli/", worktreeDir: "~/copies" }, f.home);
  assert.equal(config.prefix, "cli/");
  assert.equal(config.worktreeDir, path.join(f.home, "copies"));
  assert.deepEqual(config.hooks, { postCreate: ["true"], preRemove: ["true"] });
  await writeFile(path.join(f.repo, ".gitwt.json"), '{"base":}');
  await assert.rejects(loadConfig(f.repo, {}, f.home), { code: "invalid_config" });
});

test("конфиг читает обычный JSON и отклоняет неверные поля до Git-операций", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.repo, ".gitwt.json"),
    '{"prefix":"", "hooks":{"postCreate":[["node","-e",""]]}}',
  );
  const config = await loadConfig(f.repo, {}, f.home);
  assert.equal(config.remote, "origin");
  assert.equal(config.base, "auto");
  assert.deepEqual(config.hooks, { postCreate: [["node", "-e", ""]], preRemove: [] });
  for (const invalid of [
    { remote: "--upload-pack" },
    { base: "" },
    { worktreeDir: 42 },
    { unknown: true },
    { hooks: null },
    { hooks: [] },
    { hooks: { unknown: [] } },
    { hooks: { postCreate: "true" } },
    { hooks: { preRemove: [[]] } },
    { hooks: { preRemove: [["node", 1]] } },
    { hooks: { preRemove: [""] } },
  ]) {
    await assert.rejects(
      createWorktree(f.repo, { branch: "invalid", from: "HEAD", home: f.home, config: invalid }),
      { code: "invalid_config" },
    );
  }
  assert.equal((await listWorktrees(f.repo)).length, 1);
});

test("комментарии, лишние запятые и не-объекты JSON отклоняются до создания worktree", async (t) => {
  const f = await fixture(t);
  for (const text of ['{ // Комментарий\n"base":"main"}', '{"base":"main",}', "null", "[]"]) {
    await writeFile(path.join(f.repo, ".gitwt.json"), text);
    await assert.rejects(
      createWorktree(f.repo, { branch: "invalid-json", from: "HEAD", home: f.home }),
      { code: "invalid_config" },
    );
  }
  assert.equal((await listWorktrees(f.repo)).length, 1);
});

test("занятый путь не перезаписывается, пробелы и кавычки в новом пути сохраняются", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'my "copy"');
  const created = await createWorktree(f.repo, {
    branch: "spaces",
    path: target,
    from: "HEAD",
    home: f.home,
  });
  assert.equal(created.worktreePath, target);
  await assert.rejects(
    createWorktree(f.repo, { branch: "other", path: target, from: "HEAD", home: f.home }),
    { code: "worktree_exists" },
  );
  assert.equal((await resolveWorktree(f.repo, target)).branch, "spaces");
});

test("хуки получают окружение, а preRemove сохраняется независимо от нового конфига", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "marker.json");
  const removed = path.join(f.root, "removed.txt");
  const created = await createWorktree(f.repo, {
    branch: "hooks",
    from: "HEAD",
    home: f.home,
    config: {
      hooks: {
        postCreate: [
          command(
            `require("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({branch:process.env.BRANCH,path:process.env.WORKTREE_PATH,head:process.env.HEAD,source:process.env.SOURCE_PATH}))`,
          ),
        ],
        preRemove: [
          command(`require("fs").writeFileSync(${JSON.stringify(removed)}, "Сохранённый хук")`),
        ],
      },
    },
  });
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
    branch: "hooks",
    path: created.worktreePath,
    head: created.head,
    source: f.repo,
  });
  await writeFile(path.join(f.repo, ".gitwt.json"), '{"hooks":{"preRemove":["exit 9"]}}');
  await removeWorktree(f.repo, "hooks");
  assert.equal(await readFile(removed, "utf8"), "Сохранённый хук");
});

test("noHooks сохраняет явное отключение, а ошибка postCreate оставляет worktree с предупреждением", async (t) => {
  const f = await fixture(t);
  const config = {
    hooks: { postCreate: [command("process.exit(9)")], preRemove: [command("process.exit(9)")] },
  };
  const disabled = await createWorktree(f.repo, {
    branch: "disabled",
    from: "HEAD",
    noHooks: true,
    home: f.home,
    config,
  });
  assert.deepEqual(disabled.warnings, []);
  assert.equal((await inspectHooks(f.repo, "disabled")).preRemove, "none");
  await removeWorktree(f.repo, "disabled");
  const failed = await createWorktree(f.repo, {
    branch: "post-failed",
    from: "HEAD",
    home: f.home,
    config,
  });
  assert.equal(failed.warnings.length, 1);
  assert.equal((await resolveWorktree(f.repo, "post-failed")).head, failed.head);
  await assert.rejects(removeWorktree(f.repo, "post-failed", { force: true }), {
    code: "command_failed",
  });
});

test("dirty и изменения preRemove блокируют удаление; force не обходит ошибку хука", async (t) => {
  const f = await fixture(t);
  const created = await createWorktree(f.repo, { branch: "dirty", from: "HEAD", home: f.home });
  await writeFile(path.join(created.worktreePath, "unsaved.txt"), "Не сохранено");
  await assert.rejects(removeWorktree(f.repo, "dirty"), { code: "worktree_dirty" });
  assert.equal(
    (await listWorktrees(f.repo, { status: true })).find((item) => item.branch === "dirty").dirty,
    true,
  );
  const before = git(["rev-list", "--all", "--count"], f.repo);
  await removeWorktree(f.repo, "dirty", { force: true });
  assert.equal(git(["rev-list", "--all", "--count"], f.repo), before);
  const hooked = await createWorktree(f.repo, {
    branch: "hooked",
    from: "HEAD",
    home: f.home,
    config: {
      hooks: { preRemove: [command('require("fs").writeFileSync("new.txt", "Изменение")')] },
    },
  });
  await assert.rejects(removeWorktree(f.repo, "hooked"), { code: "worktree_dirty" });
  assert.equal(await readFile(path.join(hooked.worktreePath, "new.txt"), "utf8"), "Изменение");
});

test("текущий checkout защищён; неслитая ветка сохраняется, слитая удаляется", async (t) => {
  const f = await fixture(t);
  await assert.rejects(removeWorktree(f.repo, "main", { force: true }), {
    code: "protected_worktree",
  });
  const created = await createWorktree(f.repo, { branch: "feature", from: "HEAD", home: f.home });
  await assert.rejects(removeWorktree(created.worktreePath, "feature"), {
    code: "protected_worktree",
  });
  await writeFile(path.join(created.worktreePath, "feature.txt"), "Фича");
  git(["add", "."], created.worktreePath);
  git(["commit", "-m", "Фича"], created.worktreePath);
  const result = await removeWorktree(f.repo, "feature");
  assert.equal(result.branchDeleted, false);
  assert.equal(result.warnings.length, 1);
  git(["merge", "--ff-only", "feature"], f.repo);
  const merged = await createWorktree(f.repo, { branch: "merged", from: "HEAD", home: f.home });
  assert.equal((await removeWorktree(f.repo, merged.worktreePath)).branchDeleted, true);
});

test("ошибки checkout и повреждённые снимки не приводят к автоматическому удалению", async (t) => {
  const f = await fixture(t);
  const created = await createWorktree(f.repo, { branch: "snapshot", from: "HEAD", home: f.home });
  const snapshot = git(
    ["rev-parse", "--path-format=absolute", "--git-path", "gitwt-hooks.json"],
    created.worktreePath,
  );
  await writeFile(snapshot, "{");
  await assert.rejects(removeWorktree(f.repo, "snapshot", { force: true }), {
    code: "invalid_hooks",
  });
  await writeFile(path.join(f.repo, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 9\n", {
    mode: 0o755,
  });
  await assert.rejects(createWorktree(f.repo, { branch: "partial", from: "HEAD", home: f.home }), {
    code: "worktree_create_failed",
  });
  assert.equal((await listWorktrees(f.repo)).length, 3);
});

test("CLI --json отдаёт единый envelope и не смешивает stdout хука с JSON", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.repo, ".gitwt.json"),
    JSON.stringify({
      hooks: {
        postCreate: [command('process.stdout.write("Вывод хука\\n"); process.exit(9)')],
      },
    }),
  );
  const target = path.join(f.root, "CLI worktree");
  const env = { ...identity, HOME: f.home };
  const run = (args) => cli(args, f.repo, env);
  const add = run(["add", "cli", "--from", "HEAD", "--path", target, "--json"]);
  assert.equal(add.status, 0);
  assert.equal(add.stderr, "");
  assert.equal(add.stdout.trim().split("\n").length, 1);
  const receipt = JSON.parse(add.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.command, "add");
  assert.equal(receipt.data.worktreePath, target);
  assert.equal(receipt.data.branch, "cli");
  assert.equal(receipt.data.warnings.length, 1);
  const cd = run(["cd", "cli"]);
  assert.equal(cd.status, 0);
  assert.equal(cd.stdout, `${target}\n`);
  const cdJson = JSON.parse(run(["cd", "cli", "--json"]).stdout);
  assert.equal(cdJson.command, "cd");
  assert.equal(cdJson.data.worktreePath, target);
  const list = JSON.parse(run(["list", "--porcelain"]).stdout);
  assert.equal(list.ok, true);
  assert.equal(list.command, "list");
  assert.equal(list.data.length, 2);
  assert.equal(
    list.data.every((item) => item.dirty === null),
    true,
  );
  assert.equal(git(["branch", "--show-current"], f.repo), "main");
});

test("CLI human add/list/remove показывает реальные ветку и путь, warnings идут в stderr", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.repo, ".gitwt.json"),
    JSON.stringify({ hooks: { postCreate: [command("process.exit(9)")] } }),
  );
  const target = path.join(f.root, "Human worktree");
  const env = { ...identity, HOME: f.home };
  const run = (args) => cli(args, f.repo, env);
  const add = run(["add", "human", "--from", "HEAD", "--path", target]);
  assert.equal(add.status, 0);
  assert.equal(add.stdout.includes("Worktree создан."), true);
  assert.equal(add.stdout.includes("Ветка: human"), true);
  assert.equal(add.stdout.includes(target), true);
  assert.match(add.stdout, /HEAD: [0-9a-f]{40}/);
  assert.match(add.stderr, /Предупреждение:.*postCreate/);
  const list = run(["list", "--status"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /\* main/);
  assert.equal(list.stdout.includes(target), true);
  assert.equal(list.stdout.includes("human"), true);
  assert.equal(list.stdout.includes("чисто"), true);
  const cd = run(["cd", "human"]);
  assert.equal(cd.status, 0);
  assert.equal(cd.stdout, `${target}\n`);
  assert.equal(cd.stderr, "");
  const remove = run(["remove", "human"]);
  assert.equal(remove.status, 0);
  assert.equal(remove.stdout.includes("Worktree удалён."), true);
  assert.equal(remove.stdout.includes("Ветка: human"), true);
  assert.equal(remove.stdout.includes(target), true);
  assert.equal(remove.stdout.includes("Ветка удалена: да"), true);
});

test("CLI нормализует ошибки аргументов в machine envelope", async (t) => {
  const f = await fixture(t);
  const env = { ...identity, HOME: f.home };
  const run = (args) => cli(args, f.repo, env);
  const unknown = run(["list", "--json", "--bogus"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  const unknownEnvelope = JSON.parse(unknown.stderr);
  assert.equal(unknownEnvelope.ok, false);
  assert.equal(unknownEnvelope.command, null);
  assert.equal(unknownEnvelope.error.code, "invalid_arguments");
  assert.deepEqual(unknownEnvelope.error.details, {});
  const extra = run(["list", "extra", "--json"]);
  assert.equal(extra.status, 1);
  const extraEnvelope = JSON.parse(extra.stderr);
  assert.equal(extraEnvelope.command, "list");
  assert.equal(extraEnvelope.error.code, "invalid_arguments");
  const missing = run(["add", "--json"]);
  assert.equal(missing.status, 1);
  const missingEnvelope = JSON.parse(missing.stderr);
  assert.equal(missingEnvelope.command, "add");
  assert.equal(missingEnvelope.error.code, "missing_argument");
});

test("--skill печатает инструкцию вне Git без команд, чтения конфигов и записи файлов", async (t) => {
  const parent = path.join(os.tmpdir(), "gitwt");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitwt.json"), "{invalid");
  const env = { ...process.env, HOME: root, PATH: "" };
  const before = await readdir(root);
  const text = cli(["--skill"], root, env);
  assert.equal(text.status, 0);
  assert.equal(text.stderr, "");
  assert.match(text.stdout, /^# Git worktrees with gitwt\n/);
  assert.match(text.stdout, /gitwt add <branch> --base <remote-branch> --json/);
  assert.match(text.stdout, /data\.worktreePath/);
  for (const mode of ["--json", "--porcelain"]) {
    const output = cli(["--skill", mode], root, env);
    assert.equal(output.status, 0);
    assert.equal(output.stderr, "");
    assert.deepEqual(JSON.parse(output.stdout), {
      ok: true,
      command: "skill",
      data: { prompt: text.stdout.trimEnd() },
    });
  }
  const mixed = cli(["add", "task", "--skill", "--json"], root, env);
  assert.equal(mixed.status, 1);
  assert.equal(mixed.stdout, "");
  assert.equal(JSON.parse(mixed.stderr).error.code, "invalid_arguments");
  assert.deepEqual(await readdir(root), before);
});

test("listWorktrees отдаёт null для live-статуса без проверки и false для чистого", async (t) => {
  const f = await fixture(t);
  git(["fetch", "origin"], f.repo);
  git(["branch", "--set-upstream-to=origin/main", "main"], f.repo);
  const created = await createWorktree(f.repo, { branch: "live", from: "HEAD", home: f.home });
  const plain = (await listWorktrees(f.repo)).find((item) => item.branch === "live");
  assert.equal(plain.dirty, null);
  assert.equal(plain.ahead, null);
  assert.equal(plain.behind, null);
  assert.equal("prunable" in plain, false);
  assert.equal("locked" in plain, false);
  const live = await listWorktrees(f.repo, { status: true });
  const clean = live.find((item) => item.branch === "live");
  assert.equal(clean.dirty, false);
  assert.equal(clean.ahead, null);
  assert.equal(clean.behind, null);
  const main = live.find((item) => item.branch === "main");
  assert.equal(main.ahead, 0);
  assert.equal(main.behind, 0);
  await writeFile(path.join(created.worktreePath, "unsaved.txt"), "Изменение");
  const dirty = (await listWorktrees(f.repo, { status: true })).find(
    (item) => item.branch === "live",
  );
  assert.equal(dirty.dirty, true);
});
