# windows-release-management Specification

## Purpose
TBD - created by archiving change release-vistash-0-1-0. Update Purpose after archive.
## Requirements
### Requirement: Windows 双安装器产物
系统 MUST 从同一版本和提交生成一个 NSIS setup EXE 与一个 MSI，且两种安装器 MUST 包含同一 Vistash release 二进制。

#### Scenario: 生成 0.1.0 候选
- **WHEN** 维护者在 Windows release 环境执行批准的打包命令
- **THEN** bundle 目录包含版本为 0.1.0 的 NSIS `-setup.exe` 与 MSI
- **AND** 缺少任一格式时发布门禁失败

### Requirement: 版本与标签一致性
发布流程 MUST 要求 `package.json`、Cargo workspace 与 `tauri.conf.json` 的 SemVer 完全一致，并在标签构建中要求标签等于 `v<version>`。

#### Scenario: 三处版本不一致
- **WHEN** 任一版本文件与其他文件不同
- **THEN** 发布验证以非零状态结束并指出冲突文件

#### Scenario: 标签与应用版本不一致
- **WHEN** `v0.1.1` 标签指向应用版本 0.1.0 的提交
- **THEN** 发布工作流在构建和上传之前失败

### Requirement: 发布工程门禁
PR、`main` 与标签发布 MUST 串行执行前端 lint、类型检查、前端测试、Rust Clippy 和 Rust 测试；标签发布还 MUST 通过 OpenSpec strict validate 与 release bundle 构建。

#### Scenario: 任一测试失败
- **WHEN** 任一必需门禁返回非零状态
- **THEN** CI 或发布工作流失败
- **AND** 不创建可公开下载的发布产物

### Requirement: 发布产物完整性
发布流程 MUST 为 NSIS 和 MSI 生成排序稳定的 SHA-256 清单，清单中的文件名与摘要 MUST 对应同一版本的实际文件。

#### Scenario: 产物完整
- **WHEN** 当前版本的 NSIS 和 MSI 均唯一存在
- **THEN** 生成包含两个条目的 `SHA256SUMS.txt`

#### Scenario: 产物缺失或重复
- **WHEN** 任一安装器缺失或找到多个候选
- **THEN** 校验和生成失败且不猜测应上传哪一个文件

### Requirement: 标签驱动的草稿发布
远程发布 MUST 只由现有 `vX.Y.Z` 标签触发，并 MUST 先创建草稿 GitHub Release 供人工检查；工作流不得从普通分支 push 自动创建版本标签。

#### Scenario: 推送 main
- **WHEN** 一个提交被推送到 `main` 且没有版本标签
- **THEN** 只运行 CI
- **AND** 不创建 GitHub Release

#### Scenario: 推送合法版本标签
- **WHEN** 已合并 `main` 的提交被推送合法且与应用版本一致的标签
- **THEN** Windows 工作流上传 NSIS、MSI 与 SHA-256 清单到同标签的草稿 Release

#### Scenario: 不可变标签的发布恢复
- **WHEN** 合法版本标签已经不可变但首次发布工作流在创建 Release 前失败
- **THEN** 维护者可以从当前 `main` 手动调度同一发布工作流并输入原标签
- **AND** 工作流 checkout 原标签提交、重新执行全部门禁并为原标签创建草稿 Release
- **AND** 工作流不得移动、删除或重建该标签

### Requirement: 未签名候选与正式签名边界
0.1.0 测试候选 MAY 未签名，但文档和发布说明 MUST 标记 SmartScreen 风险；公开正式分发前 MUST 完成可信 Authenticode 签名决策。仓库 MUST NOT 包含签名私钥、证书密码或 updater 私钥。

#### Scenario: 构建未签名候选
- **WHEN** 维护者在未配置签名凭据的受控环境构建 0.1.0
- **THEN** 构建可生成标记为测试候选的安装器
- **AND** 发布说明提示 Windows SmartScreen 风险

### Requirement: 暂不启用自动更新
0.1.0 MUST NOT 安装或配置 Tauri updater；未来启用 updater MUST 通过独立变更定义签名密钥、HTTPS 端点、密钥备份、轮换和失败恢复。

#### Scenario: 检查 0.1.0 配置
- **WHEN** 维护者审查依赖、capability 与 `tauri.conf.json`
- **THEN** 不存在 updater 插件、权限、端点或占位私钥

### Requirement: 安装生命周期保留使用者数据
安装、同版本重装、补丁升级与卸载 MUST NOT 删除 `%APPDATA%\com.vistash.app` 或用户选择的素材库；卸载后重新安装 MUST 能重新打开兼容库。

#### Scenario: 隔离配置卸载与重装
- **WHEN** 测试者在隔离 Windows 配置下安装 Vistash、打开测试库、卸载并重新安装
- **THEN** 测试配置与素材库文件保持存在
- **AND** 重装后的应用能够重新打开测试库

### Requirement: 不可变发布与热修复
已公开的版本标签 MUST NOT 移动或覆盖；问题修复 MUST 通过更高 SemVer 版本发布，回滚不得依赖删除使用者数据或覆盖旧 tag。

#### Scenario: 已发布版本需要修复
- **WHEN** 0.1.0 发布后发现阻断缺陷
- **THEN** 维护者从对应 tag 建立热修复并发布更高 patch 版本
- **AND** `v0.1.0` 仍指向原提交
