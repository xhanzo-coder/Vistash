## 背景与原因

Vistash 目前没有供 Codex 与 Claude 共同遵循的开发工作流，导致不同会话中的 Skill 选择、实施顺序和进度记录可能发生漂移。在应用代码开始开发之前建立统一流程，可以让后续每项功能都能从规格、设计、任务追踪到验证结果。

## 变更内容

- 创建一个由 Codex 与 Claude 共用的项目级 Skill 入口，并把选定的工程 Skill 从已配置的中央 Skill 库链接到该入口。
- 将批准的 Tauri、Rust、React 和界面审查 Skill 加入中央库，并通过项目入口提供给两个 Agent。
- 在 `AGENTS.md` 与 `CLAUDE.md` 中定义从调研、规格、设计、实施、测试、审查到发布自动化的 Skill 使用顺序。
- 为仓库初始化 OpenSpec，要求所有实质性开发工作都具有提案、规格、设计和任务记录。
- 每完成并验证一项工作，就立即更新 OpenSpec 任务复选框；只有严格校验通过后才能归档变更。
- 通过项目级 `openspec/config.yaml` 强制后续 OpenSpec 产物使用简体中文。

## 能力范围

### 新增能力

- `development-workflow`：定义 Codex 与 Claude 必须遵循的 OpenSpec 生命周期、Skill 使用顺序、项目级 Skill 所有权规则和验证要求。

### 修改能力

无。

## 影响范围

- 项目配置：`.agents/skills`、`.codex/skills`、`.claude/skills`、`.claude/commands/opsx`。
- Agent 指南：`AGENTS.md` 与 `CLAUDE.md`。
- 进度记录：`openspec/specs` 与 `openspec/changes`。
- 中央 Skill 库：新增三个外部来源仓库，但不修改现有用户级 Skill Linker 配置。
- OpenSpec 语言规则：新增 `openspec/config.yaml`。
- 本次基础设施变更不修改应用运行时代码和公开 API。
