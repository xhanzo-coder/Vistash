# Vistash 的 Claude 开发规范

必须首先读取并遵守 `AGENTS.md`。它是 Codex 与 Claude 共用的主规范。本文件重复完整 Skill 顺序，确保 Claude 能确定性地选择 Skill，并补充 Claude 专用的 OpenSpec 调用方式。

## 语言要求

- 对用户的回复、项目文档、OpenSpec 产物、任务说明和代码注释统一使用简体中文。
- Skill 名称、命令、代码标识符、文件路径、协议名、库名和 OpenSpec 固定解析关键字保留原文。
- 不得因为第三方 Skill 的原始说明是英文，就把项目产物写成英文。

## Claude 的 OpenSpec 命令

项目级命令位于 `.claude/commands/opsx`：

- `/opsx:explore`：探索想法或不确定性，不实施生产代码。
- `/opsx:propose <change>`：为实质性变更创建中文提案、规格、设计和任务。
- `/opsx:apply <change>`：实施已经批准的任务，并在验证后更新复选框。
- `/opsx:archive <change>`：只在测试和严格校验通过后归档。

需要精确检查时直接使用 CLI：

```powershell
openspec status --change <change-id>
openspec instructions <artifact> --change <change-id>
openspec validate <change-id> --strict --no-interactive
openspec archive <change-id> -y
```

不得把聊天记录或文字状态说明当作进度台账；当前 OpenSpec `tasks.md` 才是事实来源。

## 全部 Skill 的使用顺序

只调用与当前任务相关的 Skill，并保持以下相对顺序：

1. `project-init`：首次完成项目需求、技术栈、结构和规范设计。
2. `setup-matt-pocock-skills`：首次初始化工程工作流约定。
3. `setup-pre-commit`：真实 lint、类型检查和测试命令存在后再配置。
4. `research`：针对不稳定或不确定的技术事实进行一手资料调研。
5. `domain-modeling`：定义领域语言、实体、约束、所有权和边界。
6. `grill-with-docs`：消除需求与架构歧义，并沉淀 ADR 和术语表。
7. `openspec-explore`：探索问题和备选方向，不实施生产代码。
8. `openspec-propose`：建立当前 OpenSpec change 的中文 proposal、specs、design 和 tasks。
9. `prototype`：用可丢弃原型回答明确的高风险设计或性能问题。
10. `codebase-design`：定义模块接口、依赖方向和测试接缝。
11. `frontend-design`：在界面精修前确定交互和视觉设计。
12. 完成或修订 OpenSpec 设计与有序任务列表。
13. `tauri-v2`：处理 Tauri 架构、IPC、权限、插件、Windows 打包和更新。
14. `rust-best-practices`：处理 Rust 后端正确性、错误、并发、性能、lint 和测试。
15. `vercel-react-best-practices`：项目目录名为 `react-best-practices`；处理 React 渲染、组件组合、数据流和 bundle 性能。
16. `tdd`：先建立失败测试或可复现验收检查。
17. `openspec-apply-change`：按当前 change 的任务逐项实施，并即时维护任务状态。
18. `implement`：把当前批准任务实现为最小但完整的纵向切片。
19. `diagnosing-bugs`：发生失败或回归时先诊断，再返回 TDD 和实施。
20. `webapp-testing`：验证前端功能、控制台、键盘交互和视觉状态。
21. `web-design-guidelines`：功能完成后审查可访问性与用户体验。
22. `code-review`：审查仓库规范与 OpenSpec 符合性。
23. `workflow-automator`：本地命令验证通过后配置 CI、打包和发布自动化。
24. 运行最终审查、相关测试和 OpenSpec 严格校验。
25. `openspec-archive-change`：全部完成并验证后归档 change。

## Claude 专用边界

- `.claude/skills` 中四个 `openspec-*` 目录是通过共享 `.agents/skills` 中心暴露的项目生成内容，允许 `openspec update` 管理它们。
- 其他 Skill 入口均指向中央原件。除非用户明确要求修改中央 Skill 并接受跨项目影响，否则不得编辑。
- 不得因为代码改动看似简单就绕过 OpenSpec。只有完全不影响行为的文字、注释或格式修改可以豁免，并且必须说明原因。
- `openspec/config.yaml` 中的中文规则对所有后续 OpenSpec 产物生效。
