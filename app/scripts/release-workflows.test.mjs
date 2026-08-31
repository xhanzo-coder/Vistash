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
  assert.match(workflow, /@fission-ai\/openspec@1\.3\.0/);
  assertInOrder(workflow, [
    "pnpm release:verify",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "cargo clippy --workspace --all-targets -- -D warnings",
    "cargo test --workspace",
    "openspec validate --all --strict --no-interactive",
  ]);
});

test("版本标签工作流先验签约与门禁，再生成双安装器草稿发布", () => {
  const workflow = readWorkflow("release.yml");

  assert.match(workflow, /tags: \["v\*\.\*\.\*"\]/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /repos\/\$env:GITHUB_REPOSITORY\/rulesets\?includes_parents=true/);
  assert.match(workflow, /refs\/tags\/v\*/);
  assert.match(workflow, /\$hasNoExclusions = @\(\$detail\.conditions\.ref_name\.exclude\)\.Count -eq 0/);
  assert.match(workflow, /\$includesVersionTags -and \$hasNoExclusions/);
  assert.match(workflow, /\$ruleTypes -contains "update"/);
  assert.match(workflow, /\$ruleTypes -contains "deletion"/);
  assert.match(workflow, /\$hasNoBypass/);
  assert.match(workflow, /git merge-base --is-ancestor \$env:GITHUB_SHA origin\/main/);
  assert.match(workflow, /node scripts\/release\.mjs verify --tag \$env:GITHUB_REF_NAME/);
  assert.match(workflow, /pnpm release:build/);
  assert.match(workflow, /pnpm release:checksums/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--draft/);
  assert.doesNotMatch(workflow, /git tag|git push/);
  assertInOrder(workflow, [
    "node scripts/release.mjs verify --tag $env:GITHUB_REF_NAME",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "cargo clippy --workspace --all-targets -- -D warnings",
    "cargo test --workspace",
    "openspec validate --all --strict --no-interactive",
    "pnpm release:build",
    "pnpm release:checksums",
    "gh release create",
  ]);
});
