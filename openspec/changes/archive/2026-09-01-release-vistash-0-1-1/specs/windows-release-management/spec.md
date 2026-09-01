## ADDED Requirements

### Requirement: 0.1.1 版本候选与旧版本隔离

系统 MUST 将 `package.json`、Cargo workspace 和 `tauri.conf.json` 的版本同步为 `0.1.1`，并从最新已合并 `main` 生成 NSIS 与 MSI 测试候选。发布流程 MUST 保留 `com.vistash.app` 和已有 `v0.1.0` tag 不变。

#### Scenario: 生成当前交互修复候选
- **WHEN** 维护者在包含关系管理修复的 `main` 提交上执行 0.1.1 发布门禁
- **THEN** 三处版本均为 `0.1.1`，安装器文件名和清单均包含 `0.1.1`
- **AND** `com.vistash.app` 与 `v0.1.0` tag 不发生变化

#### Scenario: 版本文件不一致
- **WHEN** 任一版本文件仍为 0.1.0 或与其他文件不同
- **THEN** 发布契约在构建前失败且不生成 0.1.1 Release 资产

### Requirement: 0.1.1 兼容 patch 发布

0.1.1 MUST 复用既有 Windows 发布门禁、不可变 tag ruleset、NSIS/MSI、SHA-256 和草稿 Release 流程，不得引入数据库、素材库或 updater 迁移。安装、升级/重装和卸载 MUST 保留用户配置与素材库。

#### Scenario: 从已验证库升级到 0.1.1
- **WHEN** 测试者在隔离配置中打开现有兼容库并安装 0.1.1
- **THEN** 应用直接进入工作区，图片—提示词关系和库文件保持可读
- **AND** 卸载/重装不删除用户配置或素材库

#### Scenario: 0.1.1 草稿资产
- **WHEN** `v0.1.1` tag workflow 全部门禁通过
- **THEN** 同一 tag 的草稿 Release 包含一个 NSIS、一个 MSI 和一个 SHA-256 清单
- **AND** 草稿说明明确未签名 SmartScreen 风险，不公开 0.1.0 旧草稿
