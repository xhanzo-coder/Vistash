# Vistash Windows 发布手册

本文定义 Vistash 从候选构建到 GitHub Release 的唯一发布流程。仓库根目录运行 `openspec` 与 Git 命令；`app/` 目录运行 `pnpm` 与 `cargo`。所有发布产物必须来自同一提交，任何门禁失败都停止发布，不使用旧产物或裸 EXE 兜底。

## 1. 版本与分支纪律

Vistash 使用 SemVer：

- patch：兼容缺陷修复，例如 `0.1.0` → `0.1.1`；
- minor：兼容的新能力，例如 `0.1.x` → `0.2.0`；
- major：存在明确不兼容契约时递增，必须包含迁移设计。

一次发布必须同步以下三处版本：

- `app/package.json` 的 `version`；
- `app/Cargo.toml` 的 `[workspace.package].version`；
- `app/src-tauri/tauri.conf.json` 的 `version`。

在 `app/` 下运行 `pnpm release:verify` 验证版本、`com.vistash.app`、NSIS/MSI 目标和未启用 updater。标签构建再运行：

```powershell
node scripts/release.mjs verify --tag v0.1.0
```

开发从 `main` 创建 `codex/` 或功能分支，完成 OpenSpec、测试和审查后合并。只有已经进入 `main`、工作树清洁且版本门禁全绿的提交可以创建标签。标签必须是不可变的 `vX.Y.Z`；禁止移动、覆盖或重复使用已推送标签。

## 2. 本机候选

在仓库根目录先运行：

```powershell
openspec validate --all --strict --no-interactive
```

再进入 `app/` 串行运行：

```powershell
pnpm install --frozen-lockfile
pnpm release:verify
pnpm lint
pnpm typecheck
pnpm test
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm release:build
pnpm release:checksums
```

不得并行运行前端测试与 Rust 全量编译。候选位于：

- `app/target/release/bundle/nsis/*-setup.exe`；
- `app/target/release/bundle/msi/*.msi`；
- `app/target/release/bundle/SHA256SUMS.txt`。

`checksums` 要求当前版本恰好存在一个 NSIS 和一个 MSI；缺失、重复或版本不匹配都会失败。`target/` 不提交 Git，候选摘要记录在当前 release change 的 validation 文档。

## 3. 未签名候选与 Authenticode

0.1.0 本机候选允许未签名，只用于受控测试。Windows SmartScreen 可能显示“Windows 已保护你的电脑”，这不是正式分发可接受的长期体验。候选说明和草稿 Release 必须明确标记“未签名测试候选”。

公开正式分发前，项目所有者必须选择可信 OV/EV Authenticode 证书或受托云签名服务。证书、PFX、密码、硬件令牌凭据和签名服务 token 只能存放在 GitHub Environments/Secrets 或受控签名系统，禁止写入仓库、日志、issue、OpenSpec 或发布附件。配置签名后必须同时验证 NSIS 和 MSI 的 Windows 数字签名与时间戳。

## 4. 隔离安装、升级与卸载矩阵

安装器验收使用专用 Windows 测试账户，或在操作前把该账户的 `%APPDATA%\com.vistash.app` 原子改名备份。测试素材库必须是明确的临时副本，禁止把真实素材库作为卸载测试目标。每一步记录安装器类型、版本、程序目录、AppData 路径、测试库路径和结果。

| 场景 | 操作 | 必须结果 |
| --- | --- | --- |
| NSIS 全新安装 | 运行 `*-setup.exe`，以默认按使用者模式安装并启动 | 应用可启动，版本为候选版本，可打开测试库 |
| NSIS 同版本重装 | 不删除 AppData/测试库，再次运行同一 setup | 应用可启动，设置与测试库仍存在 |
| MSI 全新安装 | 在清洁测试账户安装 `.msi` 并启动 | 应用可启动，版本与 NSIS 一致 |
| patch 升级 | 安装更高 patch 候选 | 设置与库不迁移到未知位置，兼容库可打开 |
| 卸载 | 从 Windows“已安装的应用”卸载当前格式 | 程序文件、快捷方式与安装登记删除；AppData 和测试库仍存在 |
| 卸载后重装 | 保留数据并重新安装同版本或更高 patch | 应用能够重新读取设置并打开测试库 |

卸载器不得删除 `%APPDATA%\com.vistash.app`、用户选择的库、导出目录或任何安装目录之外的文件。若测试需要清理隔离数据，必须在确认应用已停止、原配置已恢复且目标绝对路径仍是专用测试目录后单独删除；清理动作不属于安装器。

## 5. GitHub Actions 与标签发布

`.github/workflows/ci.yml` 在 PR 和 `main` push 上运行版本契约、前端门禁、Rust 门禁与 OpenSpec strict validate，不创建发布。

`.github/workflows/release.yml` 只响应 `v*.*.*` 标签，并验证标签提交已经进入 `main`、标签等于 `v<应用版本>`。通过全部门禁后生成 NSIS、MSI 和 SHA-256 清单，再用现有标签创建草稿 GitHub Release。工作流不执行 `git tag` 或 `git push`，也不会从普通分支自动发布。

首次发布前，项目所有者必须在 GitHub `Settings → Rules → Rulesets` 创建并启用 tag ruleset：目标包含 `refs/tags/v*`、不设置 exclusion，启用“Restrict updates”和“Restrict deletions”，且不配置 bypass actor。标签工作流会通过 GitHub API 读取并验证这些条件；未配置时在构建之前失败。该远程仓库设置不能由本地提交代替。

本地完成以下检查并得到项目所有者明确授权后，才可在清洁 `main` 上创建标签：

```powershell
git switch main
git pull --ff-only
git status --short
node app/scripts/release.mjs verify --app-root app --tag v0.1.0
git tag -a v0.1.0 -m "Vistash 0.1.0"
git push origin v0.1.0
```

0.1.0 尚未配置 Git 身份签名，经项目所有者确认后使用未签名 annotated tag；其不可变性由上面的 active tag ruleset 强制，工作流在构建前再次验证 ruleset。后续配置 Git tag 签名后改用 `git tag -s`，但不得移动或重建已经发布的 `v0.1.0`。工作流生成草稿后人工复核来源提交、两个安装器、`SHA256SUMS.txt`、安装包签名状态、安装矩阵和发布说明，最后才公开草稿。

## 6. 热修复与回滚

已发布版本发现阻断缺陷时：

1. 从对应 tag 建立热修复分支；
2. 为修复建立独立 OpenSpec change；
3. 修复回到 `main` 并递增 patch；
4. 重新执行完整门禁、安装矩阵与签名；
5. 发布新的不可变标签。

不得移动旧 tag、用新文件覆盖旧 Release 附件，或通过卸载用户数据实现“回滚”。需要撤回时先把有问题的 GitHub Release 标记为非公开并说明原因，再发布更高 patch。素材库格式变更必须保持前向迁移和明确备份，不能靠旧安装器写回新库。

## 7. 0.1.0 不启用 updater

Tauri updater 与 Windows Authenticode 是两层不同签名。0.1.0 不包含 `tauri-plugin-updater`、`@tauri-apps/plugin-updater`、`updater:default` capability、endpoint、公钥、私钥或 `.sig` 产物，也不展示占位更新入口。

未来启用 updater 必须单独建立 OpenSpec change，并至少定义：

- updater 私钥的离线备份、CI 注入、轮换与遗失恢复；
- 应用内公钥和 HTTPS/GitHub Release endpoint；
- 签名失败、端点不可达、下载中断、重复安装和降级拒绝；
- `latest.json` 的生成、原子发布与回滚；
- Authenticode 与 updater 签名的双重验证。

私钥永远不得提交仓库。未完成上述设计前，不得以硬编码空 key、HTTP endpoint 或禁用签名的方式提前接入 updater。
