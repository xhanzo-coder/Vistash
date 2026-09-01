## Why

Vistash 的运行时版本已统一为 `0.1.0`，但当前仓库只能生成裸 release 可执行文件，没有面向使用者的 Windows EXE 安装器、可重复发布流程、签名决策和版本维护契约。现在需要先产出可安装的 0.1.0 测试候选，并把“何时合并、何时打标签、如何发布、后续如何更新”固化为项目流程，避免把一次本机构建误称为正式发布。

## What Changes

- 同时生成面向普通使用者的 NSIS `-setup.exe` 与便于企业部署的 MSI；0.1.0 测试候选允许未签名，但必须明确标记 SmartScreen 风险，不冒充正式签名版。
- 建立发布前门禁：工作树与 `main`、版本号、OpenSpec、前端/Rust 测试、release 构建、安装/卸载和数据兼容检查必须一致。
- 建立 GitHub Actions 的 PR/主分支 CI 与基于 `vX.Y.Z` 标签的 Windows 发布工作流；构建产物、校验和与发布说明从同一提交生成。
- 规定 SemVer、分支、提交、标签、GitHub Release、热修复与回滚纪律；正式 0.1.0 只从已确认并合并的 `main` 提交发布。
- 记录 Authenticode 与 Tauri updater 的分层方案：公开分发前使用可信 Windows 签名；自动更新必须另行配置 Tauri updater 密钥、HTTPS/GitHub Release 端点与密钥备份，0.1.0 不静默内置未完成的 updater。
- 保留现有 `com.vistash.app` identifier，避免当前本机库设置与应用数据目录失联；跨平台发布前再通过带迁移设计的独立变更处理标识符。

## Capabilities

### New Capabilities

- `windows-release-management`: Windows 安装包、版本同步、发布门禁、签名、CI/CD、发布产物与后续更新流程。

### Modified Capabilities

无。

## Impact

- `app/src-tauri/tauri.conf.json`：增加 NSIS bundle 与 Windows 安装器元数据。
- `app/package.json` 与发布脚本：增加可重复的 release/校验和命令。
- `.github/workflows/`：新增 CI 和 Windows tag release 工作流。
- 根目录发布文档：版本策略、发布清单、签名/updater 密钥管理与回滚说明。
- 本轮会生成本机 0.1.0 未签名候选安装包；正式 tag、GitHub Release、签名证书购买和 updater 私钥生成均不在未确认状态下执行。
