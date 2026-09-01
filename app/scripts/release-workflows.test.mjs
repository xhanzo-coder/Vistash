import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

function readWorkflow(name) {
  return readFileSync(resolve(repositoryRoot, ".github", "workflows", name), { encoding: "utf8" });
}

function assertInOrder(source, fragments) {
  let cursor = -1;
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `缺少 workflow 片段：${fragment}`);
    assert.ok(index > cursor, `workflow 顺序错误：${fragment}`);
    cursor = index;
  }
}

test("PR 与 main CI 从正确目录串行执行全部工程门禁", () => {
  const workflow = readWorkflow("ci.yml");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /working-directory: app/);
  assertInOrder(workflow, [
    "pnpm release:verify",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "cargo clippy --workspace --all-targets -- -D warnings",
    "cargo test --workspace",
  ]);
});

test("版本标签工作流先验签约与门禁，再生成双安装器草稿发布", () => {
  const workflow = readWorkflow("release.yml");

  assert.match(workflow, /tags: \["v\*\.\*\.\*"\]/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /repos\/\$env:GITHUB_REPOSITORY\/rulesets\?includes_parents=true/);
  assert.match(workflow, /refs\/tags\/v\*/);
  assert.match(workflow, /\$detail\.name -ne "immutable-version-tags"/);
  assert.match(workflow, /\$hasNoExclusions = @\(\$detail\.conditions\.ref_name\.exclude\)\.Count -eq 0/);
  assert.match(workflow, /\$includesVersionTags -and \$hasNoExclusions/);
  assert.match(workflow, /\$ruleTypes -contains "update"/);
  assert.match(workflow, /\$ruleTypes -contains "deletion"/);
  assert.match(workflow, /\$bypassIsVisible = \$detail\.PSObject\.Properties\.Name -contains "bypass_actors"/);
  assert.match(workflow, /-not \$hasVisibleBypass/);
  assert.match(workflow, /\$releaseCommit = git rev-parse HEAD/);
  assert.match(workflow, /git merge-base --is-ancestor \$releaseCommit origin\/main/);
  assert.match(workflow, /node scripts\/release\.mjs verify --tag \$env:RELEASE_TAG/);
  assert.match(workflow, /pnpm release:build/);
  assert.match(workflow, /pnpm release:checksums/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--draft/);
  assert.doesNotMatch(workflow, /git tag|git push/);
  assertInOrder(workflow, [
    "node scripts/release.mjs verify --tag $env:RELEASE_TAG",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "cargo clippy --workspace --all-targets -- -D warnings",
    "cargo test --workspace",
    "pnpm release:build",
    "pnpm release:checksums",
    "gh release create",
  ]);
});

test("不可变标签的失败发布可由 main 工作流按原标签安全重跑", () => {
  const workflow = readWorkflow("release.yml");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tag:\s*\n\s*description: 要重新发布的既有版本标签/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(workflow, /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /node scripts\/release\.mjs verify --tag \$env:RELEASE_TAG/);
  assert.match(workflow, /gh release create \$env:RELEASE_TAG/);
  assert.doesNotMatch(workflow, /git tag|git push/);
});
