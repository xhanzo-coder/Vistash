## ADDED Requirements

### Requirement: 外部贡献者入口与许可证边界

公开仓库 MUST（必须）通过 README 链接到唯一的贡献指南和安全政策。贡献指南 MUST（必须）说明仓库根与 `app/` 的命令边界、OpenSpec 变更要求、串行工程门禁、简体中文文档规则和 PR 验收入口；许可证政策 MUST（必须）说明 Vistash 自有代码与第三方依赖的适用范围。

#### Scenario: 贡献者准备 PR

- **WHEN** 外部贡献者从 README 进入贡献指南
- **THEN** 能够按仓库相对路径安装依赖、运行前端/Rust 门禁、创建 OpenSpec change 并提交 PR
- **AND** 不需要项目维护者本机的 Skill junction、绝对路径或私有配置

#### Scenario: 贡献者修改文档或资产

- **WHEN** 贡献者修改 README、截图、图标或依赖归属说明
- **THEN** 必须同时说明来源/许可证并通过 UTF-8、路径泄漏和链接检查
- **AND** 不把匿名测试截图、个人素材或凭据提交到仓库
