## 背景

Vistash 是一个从零开始开发的 Windows 桌面应用，目标是成为本地优先的 Eagle 替代品。Codex 与 Claude 都会参与仓库开发，可复用 Skill 已经通过外部中央库管理。仓库需要一个统一可发现的 Skill 入口，以及一个持久、可审计的开发进度事实来源。

当前 Skill Linker 配置指向 `E:\.118-skill-linker\AgentSkills`，本机已安装 OpenSpec 1.3.0。OpenSpec 会在 `.claude/commands/opsx` 下生成 Claude 命令，并在 `.claude/skills` 下生成工作流 Skill；由于 `.claude/skills` 是共享项目入口的 junction，这些生成的 Skill 会显示在 `.agents/skills` 中。

## 目标与非目标

**目标：**

- 让 Codex 与 Claude 发现完全相同的已批准项目 Skill。
- 可复用工程 Skill 和技术 Skill 只保留一个中央原件。
- OpenSpec 生成的工作流内容留在当前仓库，并可由 `openspec update` 安全更新。
- 以 OpenSpec 产物和任务复选框作为持久的开发进度记录。
- 定义确定性的 Skill 顺序，同时不强制每个任务调用所有 Skill。
- 让当前及未来的 OpenSpec 可读内容统一使用简体中文。

**非目标：**

- 本次不初始化 Tauri 应用代码，也不决定全部运行时依赖。
- 本次不定义完整的 Vistash 产品路线图或媒体领域模型。
- 本次不把项目 Skill 全局安装到 Codex 或 Claude。
- 本次不启用 OpenSpec 会写入用户级目录的 Codex 全局 prompt 集成。
- 不翻译 OpenSpec、第三方 Skill 或命令行工具必须保留的机器标识符。

## 技术决策

### 使用 `.agents/skills` 作为项目 Skill 中心

`.agents/skills` 是真实的项目目录，`.codex/skills` 和 `.claude/skills` 均通过 Windows junction 指向它。这样既能让两个 Agent 发现一致的 Skill，又能保留彼此独立的 Agent 命令目录。

备选方案是分别为 Codex 与 Claude 保存两份副本。该方案会造成内容漂移，更新也难以审计，因此不采用。

### 通过 Skill Linker 中央化可复用 Skill

19 个已批准的可复用 Skill 均从项目入口通过 junction 指向已配置的中央库。三个外部仓库使用彼此不同的中央目录名，以避免通用仓库名冲突。

备选方案是直接把外部 Skill 安装进项目。该方案会绕过既有中央库生命周期，因此不采用。

### OpenSpec 生成的工作流 Skill 由项目持有

OpenSpec 生成的四个 `openspec-*` Skill 以真实目录形式保留在项目入口中。它们与当前 OpenSpec 版本绑定；如果中央化，一个项目执行 `openspec update` 就可能修改其他项目共享的原件。

### Codex 使用项目级 OpenSpec 集成

OpenSpec 的 Codex 适配器会把斜杠 prompt 写入用户级 Codex 主目录。为保持“仅当前项目”的范围，Codex 按 `AGENTS.md` 中记录的 OpenSpec CLI 流程工作；Claude 另外使用项目级 `/opsx:*` 命令。

### `AGENTS.md` 是规范主文件

`AGENTS.md` 包含 Codex 与 Claude 共用的完整流程。`CLAUDE.md` 增加 Claude 专用调用方式，并明确继承主规范，避免维护两套彼此独立的流程。

### 通过 `openspec/config.yaml` 固定中文产物

项目配置向所有 OpenSpec 产物指令注入“使用简体中文”的上下文，并为 proposal、specs、design、tasks 分别设置中文规则。OpenSpec 解析所需的固定关键字、命令和标识符继续保留英文。

## 风险与权衡

- **风险：OpenSpec 生成的 Skill 是 centralize 模式项目入口中的真实目录。** → 把它们记录为明确的项目级例外，并验证其他 19 项均为中央 junction。
- **风险：Windows 绝对 junction 无法直接移植到另一台机器。** → 把链接视为本机开发配置；迁移机器时通过 Skill Linker 重新生成。
- **风险：完整 Skill 顺序可能产生形式主义。** → 只调用符合触发条件的 Skill，但保持已选择 Skill 的相对阶段顺序。
- **风险：第三方 Skill 更新会改变 Agent 行为。** → 仓库保持 Git 管理，更新前审查差异，并只通过 Skill Linker 执行 fast-forward 更新。
- **风险：中文化破坏 OpenSpec 解析。** → 仅翻译可读文本，保留 `ADDED Requirements`、`Requirement`、`Scenario`、`WHEN`、`THEN` 等固定语法。

## 迁移与实施步骤

1. 把三个批准的外部 Skill 仓库克隆到已配置中央库。
2. 初始化项目 Skill 中心以及 Codex、Claude junction。
3. 通过 Skill Linker 链接全部已批准的可复用 Skill。
4. 为当前项目和 Claude 集成初始化 OpenSpec。
5. 添加中文 OpenSpec 配置、共享 Agent 指南和 Claude 专用指南。
6. 验证 Skill 链接、UTF-8 编码、OpenSpec 产物和仓库状态。

回滚时只移除项目 junction 和 OpenSpec 生成的项目文件，并且必须先取得明确授权；项目回滚不会删除中央原件。

## 待确定问题

- 第一个产品变更需要通过专项架构提案，决定初始运行时是否正式采用 Tauri 2、React/TypeScript、Rust 和 SQLite。
