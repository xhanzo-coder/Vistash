## Context

Vistash 已经公开发布 `v0.1.1`，但仓库仍缺少标准许可证和社区治理入口。公开审计还发现少量 Agent/OpenSpec 历史记录包含开发者本机路径或用户名；这些内容不是运行时秘密，但会降低公开仓库的可移植性。现有匿名测试截图和 Tauri 图标已经存在，只需要从测试证据中精选并以产品文档资产的方式呈现。

## Goals / Non-Goals

**Goals:**

- 让 GitHub 能检测到标准 MIT 许可证，并让 npm/Cargo 元数据与 README 的许可证说明一致。
- 为外部贡献者提供可执行的贡献、漏洞报告、Issue 和 PR 入口。
- 在 README 顶部展示真实产品图标和经过筛选的匿名生产界面截图。
- 清理公开文档中的机器专属路径和用户名，同时保留可追溯的 OpenSpec 与测试历史。
- 记录第三方依赖许可证审计结果；只有有实际通知义务时才生成 `THIRD_PARTY_NOTICES.md`。

**Non-Goals:**

- 不删除 `.agents/skills`、`.claude/commands`、`openspec`、测试证据或历史 tag。
- 不修改运行时代码、数据库、安装器、Release 资产或公开版本 tag。
- 不把 MIT 文本扩展为禁止商用、禁止 AI 或其他领域限制。
- 不公开个人素材、签名凭据、模型 API Key 或本机完整路径。
- 暂不添加无法提供真实报告渠道的 `CODE_OF_CONDUCT.md`；社区行为准则另行决定。

## Decisions

### 1. 使用标准 MIT 许可证

以 `xhanzo-coder` 作为当前 GitHub 著作权标识，在根目录加入 OSI 发布的标准 MIT 全文。README 说明 MIT 适用于 Vistash 自有源代码、文档和明确归属的自有资产；第三方依赖、字体、图标和截图不因根 LICENSE 而改变各自许可证。Cargo workspace 与成员 crate 使用 `license = "MIT"`/`license.workspace = true`，前端包元数据使用 `"license": "MIT"`。

备选方案是 Apache-2.0（专利条款更完整）或 GPL-3.0（强 copyleft）；当前个人桌面工具优先选择低摩擦复用，因此采用 MIT。不得混入自定义限制或使用未核对的许可证模板。

### 2. 社区文件集中放在 `.github/`

贡献指南、安全政策、Issue 表单和 PR 模板放入 `.github/`，README 只链接这些权威文件，避免根目录和 `.github/` 出现重复副本。`SECURITY.md` 只承诺 GitHub Security Advisory/私下报告，不要求使用者把漏洞细节发到公开 Issue。由于当前没有公开且可执行的行为问题联系人，本变更不创建空泛的行为准则模板。

### 3. 产品截图与图标单独归档

从已跟踪的匿名生产/验收截图中选取欢迎页、图片工作区、提示词工作区和多图关联状态，复制到 `docs/assets/screenshots/`；从已批准 Tauri 图标复制 `docs/assets/vistash-icon-256.png`。README 仅引用这些稳定路径，图片加中文 alt、尺寸和“匿名测试数据”说明，不把整套 `app/artifacts/` 当作营销素材，也不引用 prototype 目录。

### 4. 路径匿名化采用定向替换

把 `AGENTS.md` 和历史设计文档中的中央 Skill/个人媒体库路径改为“开发者本机 Skill 库”“本机媒体库”等可移植描述；把 `app/artifacts/merge-blockers/native-report.json` 中的 Windows 用户目录替换为 `%TEMP%` 形式。`E:\vistash-release-e2e` 这类专用测试根路径保留，因为它是脚本约定且不含用户名。只提交当前工作树修复，不做 Git 历史重写。

### 5. 第三方许可证先审计后决定通知文件

使用 `pnpm licenses list --json`、Cargo manifest/lock 和实际打包资产清单核对依赖、图标、字体和截图。若上游要求保留 NOTICE 或版权文本，生成 `THIRD_PARTY_NOTICES.md` 并在 README/发布文档链接；若仅能确认许可证 ID 而无法可靠取得完整通知内容，记录审计结果并不创建空 NOTICE。

## Risks / Trade-offs

- [Risk] MIT 著作权标识不符合实际权利人 → 提交前由项目所有者核对 `xhanzo-coder` 与最终法律名称，必要时只改 LICENSE 标题行。
- [Risk] 根 LICENSE 被误读为覆盖第三方资产 → README、第三方通知和截图目录说明明确各自范围。
- [Risk] 社区文件承诺了无法响应的渠道 → SECURITY 只提供已有 GitHub 私下报告能力，行为准则延后到联系人确定后。
- [Risk] 历史路径清理破坏测试证据 → 只替换展示文本和 JSON 诊断中的环境前缀，运行脚本与断言不改；完成后运行全部文档/工程门禁。
- [Risk] README 截图包含测试文案或个人内容 → 只使用匿名 fixture，逐张视觉检查并在 README 标注测试数据。

## Migration Plan

1. 在当前 `main` 创建 OpenSpec change 分支，完成许可证、社区文件、截图/图标、路径清理和第三方审计任务。
2. 将标准 MIT 文本、元数据和 README/社区文件提交到 PR；运行 UTF-8、路径泄漏、链接、许可证和 OpenSpec 检查。
3. 串行通过现有前端/Rust 门禁，确认无运行时行为变化。
4. 合并 PR 后在 GitHub 核对 License 检测、README 图片、Issue/PR 入口和仓库描述/topics；不改变 `v0.1.1` Release。
5. 若发现历史中真正的秘密，立即停止公开传播并按凭据轮换/历史清理流程另立变更；本次不执行历史重写。

## Open Questions

- 当前无阻断问题。MIT LICENSE 暂以 GitHub 项目标识 `xhanzo-coder` 作为著作权标识；若后续确认法律主体不同，应通过独立变更更新许可证和元数据。
- 是否在社区开始增长后补充可执行的 `CODE_OF_CONDUCT.md` 和公开行为问题联系人。
