## Context

Vistash 的 `package.json`、Cargo workspace 与 `tauri.conf.json` 已统一为 `0.1.0`，当前 Windows 主机能够生成 `target/release/vistash.exe`，但 `bundle.targets` 只包含 MSI，仓库没有 CI、标签发布工作流、版本一致性检查、校验和清单或发布运行手册。裸可执行文件与一次本机构建都不能作为可重复发布流程。

发布流程必须服从本地优先边界：安装、升级和卸载不得删除或迁移 `%APPDATA%\com.vistash.app` 与使用者素材库；`com.vistash.app` 在 0.1.0 保持不变。0.1.0 候选允许未签名，但必须明确提示 SmartScreen 风险。Tauri updater 的签名密钥、HTTPS 端点和应用内更新界面尚未获批，因此本变更只记录后续方案，不安装 updater 插件。

## Goals / Non-Goals

**Goals:**

- 在 Windows 上从同一提交生成 NSIS `-setup.exe` 与 MSI。
- 用可执行脚本验证三处版本一致、标签与版本匹配、发布产物完整并生成 SHA-256 清单。
- 建立 PR/`main` CI 与 `vX.Y.Z` 标签触发的 Windows 草稿发布工作流。
- 固化未签名候选、正式签名、安装/升级/卸载、热修复和回滚纪律。
- 在本机生成并验证 0.1.0 未签名候选，但不创建远程 tag 或 GitHub Release。

**Non-Goals:**

- 不购买或导入 Authenticode 证书，不生成、提交或托管任何私钥。
- 不安装 `tauri-plugin-updater`，不生成 updater 私钥、`.sig` 或 `latest.json`。
- 不发布 macOS、Linux、ARM 或 Microsoft Store 包。
- 不在工作树未清洁、未合并 `main` 或仍有未完成发布门禁时创建 `v0.1.0` 标签。
- 不改变应用 identifier、应用数据目录或素材库格式。

## Decisions

### 1. 同时生成 NSIS 与 MSI

`bundle.targets` 固定为 `nsis` 与 `msi`。NSIS 面向普通使用者，MSI 面向需要 Windows Installer 部署的环境；两者必须来自同一源码提交和版本。备选方案“只发布 MSI”缺少普通使用者熟悉的 setup EXE；“只发布 NSIS”无法满足企业部署场景，因此拒绝。

安装模式保持默认的按使用者安装，不申请管理员权限。WebView2 使用 Tauri 默认 bootstrapper 策略；0.1.0 不为离线运行时额外增大安装包。未来若要 per-machine 或离线 WebView2，必须另建变更并验证升级路径。

### 2. Node 脚本作为发布契约入口

新增无第三方依赖的 `scripts/release.mjs`，提供 `verify` 与 `checksums` 两个子命令：

- `verify` 直接解析 UTF-8 的 `package.json`、`src-tauri/tauri.conf.json` 和 Cargo workspace TOML，要求 SemVer 完全一致、identifier 仍为 `com.vistash.app`、目标同时包含 `nsis`/`msi`；在标签环境中还要求 `v<version>` 与版本一致。
- `checksums` 只接受显式 bundle 目录，要求恰好能找到当前版本的一个 NSIS EXE 和一个 MSI，为它们生成排序稳定的 `SHA256SUMS.txt`；缺失、重复或版本不匹配直接失败。

不用 shell 通配符拼接发布逻辑，避免 PowerShell/Bash 差异；不用运行时 fallback 猜测版本或产物。脚本以 Node 内置测试锁定错误语义。

### 3. CI 与发布分离

`.github/workflows/ci.yml` 在 PR 与 `main` push 上串行运行前端 lint、类型检查、测试，再运行 Rust Clippy 与测试。前后端门禁不并行，遵守仓库已记录的 Vitest CPU 饥饿约束。CI 不生成 GitHub Release。

`.github/workflows/release.yml` 只响应 `v*.*.*` 标签，并先验证标签、版本、OpenSpec 和全部工程门禁，再在 `windows-latest` 构建 `nsis,msi`、生成校验和并创建 GitHub 草稿 Release。草稿状态给维护者检查文件名、SmartScreen 提示和发布说明的机会；人工发布草稿前必须完成签名决策。备选方案“push 到 main 自动发布”会把合并与外部分发耦合，拒绝。

工作流使用官方 GitHub CLI `gh release create` 上传现有标签的产物，不让 action 隐式创建标签。所有第三方 action 使用明确主版本；Tauri 构建由仓库锁定的本地 CLI 执行，避免全局 CLI 漂移。

### 4. 版本与分支纪律

正常开发从 `main` 建立 `codex/` 或功能分支，经 CI 和 OpenSpec 审查后合并。发布提交先同步三处版本与发布说明，门禁全绿且工作树清洁后才在 `main` 创建 annotated 标签 `vX.Y.Z`。0.1.0 尚未建立 Git 身份签名基础设施，因此经用户确认后采用未签名 annotated tag，并由 active tag ruleset 禁止 `refs/tags/v*` 的更新与删除且不允许 bypass；后续启用 Git tag 签名时必须继续保留该不可变规则。Windows Authenticode 与 Git tag 身份签名属于不同信任层，本决定不把未签名安装包表述为正式签名版。

补丁热修复从对应发布 tag 建分支，修复通过独立 OpenSpec 变更回到 `main`，递增 patch 后发布新标签；不得覆盖或移动既有 tag。回滚通过撤销发布或发布更高 patch 完成，不让安装器删除使用者数据。

### 5. 签名与 updater 分层

0.1.0 本机候选允许未签名，产物名和文档必须明确“测试候选”，使用者会遇到 SmartScreen。公开正式分发前应使用可信 OV/EV Authenticode 证书，并将证书材料放在 GitHub Environments/Secrets 或受控签名服务，仓库只保存非秘密配置。

Tauri updater 需要独立 updater 私钥、应用内公钥、HTTPS/GitHub Release 端点和恢复备份。它与 Authenticode 解决不同信任层，不能互相替代。本变更不加入 updater 依赖、权限或配置；未来变更必须先定义密钥轮换、端点故障、降级保护和离线恢复。

### 6. 安装数据不属于安装器所有

安装/升级/卸载验收使用隔离 Windows 使用者配置和临时素材库。验证卸载只删除程序文件、快捷方式和安装登记，不删除 `%APPDATA%\com.vistash.app` 或用户选择的库；重新安装同版本或更高 patch 后能够重新打开原库。任何安装器自定义删除用户数据的逻辑均禁止进入 0.1.0。

## Risks / Trade-offs

- [Risk] 未签名候选触发 SmartScreen，降低首次安装信任 → 候选只用于受控测试，文档醒目标记；公开发布前完成 Authenticode。
- [Risk] Windows runner 或本机首次打包需要下载 WiX/NSIS 工具 → 使用 Tauri 标准 bundle 流程并保留构建日志；CI 失败不降级为只上传裸 EXE。
- [Risk] GitHub 标签误推会启动发布工作流 → 工作流首先验证三处版本与标签，产物只创建为 draft；保护 `main` 和 release environment 作为仓库侧后续设置。
- [Risk] 安装/卸载测试污染真实配置 → 使用隔离 Windows 配置与临时库，操作前后显式验证路径；真实配置不进入安装器测试。
- [Risk] 同时维护 NSIS/MSI 增加测试矩阵 → 0.1.0 两种格式共享同一二进制与自动契约，只保留一次人工安装/升级/卸载矩阵记录。
- [Trade-off] 暂不提供自动更新 → 降低 0.1.0 的密钥和供应链风险，但后续版本需要用户手动下载安装。

## Migration Plan

1. 补齐发布规格与任务，并通过 OpenSpec strict validate。
2. 增加版本/产物验证脚本及测试，配置 NSIS+MSI。
3. 增加 CI、tag 发布工作流和发布运行手册。
4. 串行运行全部工程门禁与 release 构建，生成本机 0.1.0 候选和 SHA-256 清单。
5. 在隔离配置下验证安装、启动、升级/重装、卸载和数据保留；不触碰真实素材库。
6. 完成审查后提交功能分支。只有合并到清洁 `main` 且用户明确授权，才创建 `v0.1.0` 标签并由工作流生成草稿 Release。

回滚时删除尚未发布的本机候选即可；已创建但未公开的草稿 Release 可删除，标签不得移动。公开版本出现问题时撤回对应 Release，并从已发布 tag 制作更高 patch 热修复；不以降版本安装器覆盖用户数据。

## Open Questions

- 公开 0.1.0 前采用 OV、EV 证书还是受托云签名服务，需由项目所有者根据预算和组织身份决定。
- GitHub 仓库需由所有者启用何种 `main` 分支保护与 release environment 审批，不能由本地代码单方面完成。
- updater 的端点、密钥托管与轮换策略留给独立 OpenSpec 变更。
