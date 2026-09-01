## Why

Vistash 当前已经是公开 GitHub 仓库，但缺少根目录 `LICENSE`、贡献与安全说明，不能准确称为开源项目。README 也缺少产品图标和经过筛选的界面截图；同时少量公开验证记录包含本机 Skill 路径、工作区路径或用户名，需要在不删除审计历史的前提下做定向匿名化。

## What Changes

- 采用标准 MIT 许可证，在仓库根目录添加 `LICENSE`，并在 npm/Cargo 元数据与 README 中声明 SPDX 标识。
- 新增 `.github/CONTRIBUTING.md`、`.github/SECURITY.md`、`.github/ISSUE_TEMPLATE/` 和 `PULL_REQUEST_TEMPLATE.md`，为公开贡献和漏洞报告提供可执行入口；暂不添加无法提供真实联系渠道的行为准则模板。
- 将现有匿名生产界面截图精选为 `docs/assets/screenshots/`，在 README 顶部展示产品图标、图片工作区、提示词工作区和图片—提示词多图关联，并保留截图来源说明。
- 更新 README 的许可证、贡献、漏洞报告和截图章节，移除“尚未授予许可”的旧表述，同时明确第三方依赖和资产仍受各自许可证约束。
- 在 `app/package.json`、Cargo workspace 与成员 crate 中补充 `MIT` 许可证元数据；不改变运行时依赖。
- 对公开 Agent/OpenSpec 文档和历史测试报告中的本机绝对路径、个人媒体库路径及用户名做定向匿名化；不删除 `.agents/skills`、`.claude/commands`、`openspec` 或完整审计历史。
- 审计第三方依赖、图标、字体和截图的归属；只有存在实际通知义务时才添加 `NOTICE` 或 `THIRD_PARTY_NOTICES.md`。

## Capabilities

### New Capabilities

- `open-source-repository-governance`：定义许可证、社区健康文件、公开素材展示、第三方归属和公开路径匿名化要求。

### Modified Capabilities

- `development-workflow`：补充外部贡献者可执行的公开贡献入口与许可证边界，但保留当前 OpenSpec 和 Agent 工作流。

## Impact

- 文档与治理：`LICENSE`、README、`.github/` 社区文件、`docs/assets/` 和公开验证记录。
- 构建元数据：`app/package.json`、`app/Cargo.toml`、`app/crates/vistash-core/Cargo.toml`、`app/src-tauri/Cargo.toml` 的许可证字段。
- GitHub：仓库会被 License 检测器识别为 MIT，README 将展示产品预览图；不改变 tag、Release 资产或运行时行为。
- 安全：不添加或公开私钥、密码、token；现有绝对路径只做可逆、可审查的文字匿名化，不执行 Git 历史重写。
