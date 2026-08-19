## ADDED Requirements

### Requirement: 共享项目 Skill 发现入口
仓库 MUST（必须）通过一个项目级 `.agents/skills` 中心暴露已批准的开发 Skill。项目级 `.codex/skills` 和 `.claude/skills` 必须解析到该中心，使 Codex 与 Claude 发现相同的 Skill 集合。

#### Scenario: Codex 与 Claude 检查项目 Skill
- **WHEN** 任一 Agent 枚举自己的项目级 Skill 目录
- **THEN** 该 Agent 能发现同一组已批准的工程 Skill 和技术 Skill

#### Scenario: 检查共享 Skill 来源
- **WHEN** 检查任一已批准的共享 Skill 入口
- **THEN** 该入口解析到已配置中央 Skill 库下包含有效 `SKILL.md` 的目录

### Requirement: OpenSpec 生成的 Skill 由项目持有
OpenSpec 生成的工作流 Skill MUST（必须）保留为项目拥有的真实目录，因为 `openspec update` 会根据当前 OpenSpec 版本管理这些内容。它们不得被视为中央共享 Skill 原件。

#### Scenario: 刷新 OpenSpec 指令
- **WHEN** `openspec update` 刷新项目集成
- **THEN** 只更新当前项目的 OpenSpec 工作流 Skill 和命令

### Requirement: OpenSpec 中文产物
项目 MUST（必须）通过 `openspec/config.yaml` 要求所有新建或修改的 OpenSpec 可读产物使用简体中文。只有 OpenSpec 解析所需的固定关键字、命令名和标识符可以保留英文。

#### Scenario: 生成新的 OpenSpec 产物
- **WHEN** Agent 获取 proposal、specs、design 或 tasks 的 OpenSpec 指令
- **THEN** 指令包含使用简体中文编写标题和正文的项目规则

### Requirement: OpenSpec 变更门禁
每项实质性功能、缺陷修复、重构、数据迁移、架构变更或发布流程变更，都 MUST（必须）在生产实现开始前建立 OpenSpec 变更。变更必须包含提案、适用规格、涉及架构决策时的设计，以及实施任务清单。

#### Scenario: 开始实质性开发
- **WHEN** Agent 收到实施实质性仓库变更的请求
- **THEN** Agent 在修改生产代码前创建或选择 OpenSpec 变更，并完成所需产物

#### Scenario: 请求无行为影响的轻量修改
- **WHEN** 修改仅涉及文字、注释或格式，并且不改变行为
- **THEN** Agent 可以不创建新 OpenSpec 变更，但必须明确说明豁免原因

### Requirement: 有序 Skill 工作流
Agent MUST（必须）按项目定义的顺序选择 Skill，并且只调用符合当前工作触发条件的 Skill。领域与设计决策确定后、实施完成前，必须应用相关技术栈指导。

#### Scenario: 开发新功能
- **WHEN** 新功能从调研进入交付
- **THEN** Agent 按初始化、调研、领域建模、规格、设计、必要时的原型、实施、测试、审查和自动化顺序工作

#### Scenario: 诊断缺陷
- **WHEN** 现有行为损坏、失败或变慢
- **THEN** Agent 先使用诊断流程，再选择实施和验证 Skill

### Requirement: 进度与完成状态追踪
Agent MUST（必须）在每项任务验证通过后立即更新 `tasks.md`。变更在归档前必须通过 OpenSpec 严格校验以及与其相关的项目测试。

#### Scenario: 实施任务验证通过
- **WHEN** 某项任务的验收检查通过
- **THEN** 对应复选框被标记为完成，并且 OpenSpec 剩余进度保持准确

#### Scenario: 变更准备归档
- **WHEN** 全部任务完成且相关验证通过
- **THEN** Agent 在把变更归档进主规格前运行 OpenSpec 严格校验
