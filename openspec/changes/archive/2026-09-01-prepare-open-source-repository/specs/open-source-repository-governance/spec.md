## ADDED Requirements

### Requirement: 标准许可证与第三方边界

仓库 MUST（必须）在根目录提供著作权人确认的标准 OSI 批准许可证，并 MUST（必须）在 README、前端包元数据和 Cargo 包元数据中使用同一 SPDX 标识。许可证说明 MUST（必须）区分 Vistash 自有代码/文档/资产与第三方依赖、字体、图标和截图；不得用自定义限制改变标准许可证。

#### Scenario: GitHub 识别许可证

- **WHEN** 访问者打开公开仓库或读取仓库 License API
- **THEN** 根目录标准许可证可被识别为 `MIT`
- **AND** README 的许可证章节链接根 `LICENSE`，不再声称仓库没有开源许可

#### Scenario: 构建包声明许可证

- **WHEN** 维护者读取 `app/package.json`、Cargo workspace 和成员 crate manifest
- **THEN** 所有 Vistash 包的机器可读许可证元数据为 `MIT`
- **AND** 第三方依赖仍按各自许可证处理，不被 Vistash 的 MIT 声明覆盖

### Requirement: 社区贡献与安全报告入口

仓库 MUST（必须）提供外部贡献者可执行的 `CONTRIBUTING.md` 与 `SECURITY.md`，并 MUST（必须）提供缺陷/功能 Issue 模板和 PR 模板。安全政策 MUST（必须）要求漏洞细节通过私下渠道报告，不引导公开披露凭据或利用步骤。只有在维护者提供真实联系人和处理能力后才添加行为准则文件。

#### Scenario: 外部贡献者提交变更

- **WHEN** 贡献者打开 README、Issue 或 PR 页面
- **THEN** 可以找到贡献指南、环境要求、OpenSpec/门禁流程和 PR 验收清单

#### Scenario: 报告安全问题

- **WHEN** 使用者发现可能影响本地数据、安装器或依赖的安全问题
- **THEN** SECURITY 文件指向 GitHub 私下安全报告入口，并明确禁止在公开 Issue 粘贴敏感细节

### Requirement: README 产品展示与事实准确

根 README MUST（必须）展示批准的产品图标和至少三张匿名真实界面截图，截图 MUST（必须）使用稳定的 `docs/assets/` 路径、中文 alt 文本和数据来源说明。README MUST（必须）准确描述当前 v0.1.1 能力、安装入口、数据/隐私、许可证和明确不支持范围，不得把测试原型或图像反推未来能力描述为当前功能。

#### Scenario: 新用户浏览 README

- **WHEN** 访问者打开仓库根 README
- **THEN** 首屏能够看到 Vistash 图标、产品一句话和公开预览下载入口
- **AND** 页面后续能够看到图片工作区、提示词工作区和图片—提示词多图关联截图及说明

#### Scenario: 截图不泄漏个人数据

- **WHEN** 维护者检查 README 引用的截图和 `docs/assets/`
- **THEN** 截图只包含匿名 fixture、产品界面和虚构文案，不包含个人素材、用户名或本机绝对路径

### Requirement: 公开仓库路径与 Agent 工具可移植

公开文档和诊断资产 MUST（必须）不包含开发者用户名、个人媒体库路径或中央 Skill 库绝对路径；应使用仓库相对路径、环境变量或明确的“本机路径”占位。`.agents/skills`、`.claude/commands` 和 `openspec` MAY（可以）保留作为开发流程资产，但本机 junction、外部 Skill 复制件和凭据 MUST NOT（禁止）提交。

#### Scenario: 外部贡献者克隆仓库

- **WHEN** 贡献者在不同 Windows 用户目录下阅读文档并按贡献指南操作
- **THEN** 文档不会要求访问项目维护者的磁盘路径或中央 Skill 库
- **AND** 贡献者可以按仓库相对路径和公开命令定位源码、测试和规格
