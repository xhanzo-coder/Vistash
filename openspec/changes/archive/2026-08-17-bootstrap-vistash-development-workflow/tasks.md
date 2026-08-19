## 1. 中央 Skill 来源

- [x] 1.1 验证当前 Skill Linker 配置和项目入口状态
- [x] 1.2 把批准的 Tauri、Apollo 和 Vercel Skill 仓库克隆到相互独立的中央库目录
- [x] 1.3 验证所选外部 Skill 目录包含有效的 UTF-8 `SKILL.md`

## 2. 项目 Skill 发现入口

- [x] 2.1 初始化共享的 `.agents/skills` 项目中心
- [x] 2.2 创建指向共享中心的 Codex 与 Claude 项目级 junction
- [x] 2.3 从中央库链接全部 19 个已批准的可复用 Skill

## 3. OpenSpec 集成

- [x] 3.1 为仓库和项目级 Claude 命令初始化 OpenSpec 1.3.0
- [x] 3.2 创建 bootstrap OpenSpec 提案、开发工作流规格和设计
- [x] 3.3 把 OpenSpec 生成的工作流 Skill 记录为中央化策略的项目级例外
- [x] 3.4 添加项目级中文上下文和各类 OpenSpec 产物的中文规则

## 4. Agent 指南

- [x] 4.1 创建 `AGENTS.md`，记录规范 OpenSpec 门禁和每个已安装 Skill 的使用顺序
- [x] 4.2 创建 `CLAUDE.md`，记录一致的 Skill 顺序和 Claude 专用 OpenSpec 命令
- [x] 4.3 将 Agent 指南与当前 OpenSpec 变更的可读内容全部改为简体中文

## 5. 验证

- [x] 5.1 验证当前项目、用户级目录和中央库的 Skill Linker 状态
- [x] 5.2 验证新增 Markdown 与 YAML 文件采用无 BOM 的 UTF-8，且不存在乱码
- [x] 5.3 运行 OpenSpec 严格校验，确认 bootstrap 变更已经具备归档条件
