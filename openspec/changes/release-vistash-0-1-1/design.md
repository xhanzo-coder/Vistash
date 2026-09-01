## Context

`main` 已合并图片—提示词关系管理改进，但现有 `v0.1.0` annotated tag 不可移动，且其草稿安装包来自旧交互。`v0.1.1` 是兼容的 patch release，只需把应用版本同步到三处并重新走已经验证过的 Windows 发布工作流。

## Goals / Non-Goals

**Goals:**

- 从最新 `main` 生成版本为 `0.1.1` 的 NSIS 和 MSI 测试候选。
- 保持 `com.vistash.app`、库格式、用户配置路径和 updater 边界不变。
- 让新 tag 触发既有 ruleset、门禁、安装器、校验和与草稿 Release 流程。
- 记录用户已完成的关系管理验收和本次候选摘要。

**Non-Goals:**

- 不移动、删除或覆盖 `v0.1.0` tag 或其草稿 Release。
- 不在本变更中新增运行时功能、数据库迁移、依赖或安装器模板。
- 不生成 Authenticode、Git signing 或 updater 私钥，不将草稿公开。

## Decisions

### 1. 只同步三处应用版本

更新 `app/package.json`、`app/Cargo.toml` 的 `[workspace.package]` 和 `app/src-tauri/tauri.conf.json` 为 `0.1.1`。pnpm lock 不记录根项目版本，不做无意义改写；identifier 继续由发布契约锁定为 `com.vistash.app`。备选方案是只改 Tauri 配置并继续使用 0.1.0 package/Cargo，这会让诊断信息和安装器元数据漂移，拒绝。

### 2. 复用既有标签工作流

版本同步后串行执行 OpenSpec、lint、typecheck、前端测试、Rust Clippy 和测试，再由 `v0.1.1` tag 触发已验证的 Windows workflow。NSIS/MSI、SHA-256 和 draft Release 均从 tag checkout 生成，不使用之前 0.1.0 或本地临时包。备选方案是手动上传本机文件，会失去同一提交和门禁证据，拒绝。

### 3. 兼容发布与数据保留

0.1.1 不改变 sidecar、SQLite 或 `com.vistash.app` 路径；安装生命周期沿用 0.1.0 已验证的隔离配置矩阵。由于这是 patch release，已有库应直接打开，不触发迁移。未签名候选继续标记 SmartScreen 风险。

## Risks / Trade-offs

- [Risk] 三处版本漏改 → 发布契约在 tag workflow 最早阶段直接失败。
- [Risk] 误把 0.1.0 旧草稿当成新包 → 新版本文件名、tag 和清单必须全部包含 `0.1.1`，不复用旧路径。
- [Risk] patch 版本引入意外数据迁移 → Rust/SQLite 规格不变，隔离库启动和重装回归锁定兼容性。
- [Risk] 未签名安装器触发 SmartScreen → 草稿和文件说明明确“测试候选”，正式公开另行完成签名。

## Migration Plan

1. 在新 OpenSpec change 中同步三处版本并运行完整门禁。
2. 合并到 `main` 后创建受保护的 annotated `v0.1.1` tag。
3. 等待 tag workflow 构建 NSIS、MSI、校验和并创建草稿 Release。
4. 在隔离账户/库中验证 0.1.1 安装、启动、升级/重装和卸载数据保留。

失败时不移动 tag；修复通过新的 PR 合并后，使用 `workflow_dispatch(tag=v0.1.1)` 从当前 `main` 重跑。若需要撤回，保留 tag 不变并删除/关闭草稿 Release，后续修复递增 patch。

## Open Questions

无。用户已完成当前关系交互验收并确认继续制作 0.1.1 测试候选。
