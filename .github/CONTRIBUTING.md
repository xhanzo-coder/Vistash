# 参与贡献 Vistash

感谢你愿意帮助改进 Vistash。Vistash 是 Windows 优先、本地优先的桌面应用；贡献前请先阅读根目录 [`README.md`](../README.md) 和 [`LICENSE`](../LICENSE)。

## 开始之前

- 当前正式目标平台是 Windows；非 Windows 平台不在公开预览的支持范围内。
- 运行时使用 Tauri 2、React/TypeScript、Rust 和 SQLite。
- 图片像素处理、缩略图和色卡计算必须留在 Rust 侧；前端不得读取像素缓冲。
- 不要提交素材库、个人图片、API Key、签名凭据、`.env` 文件或本机绝对路径。

## 本地环境

请安装 Node.js、pnpm、Rust stable MSVC toolchain、Visual Studio 生成工具和 WebView2 Runtime。项目有两个命令工作目录：

- 仓库根目录：Git、OpenSpec 和文档命令；
- `app/`：pnpm、前端测试和 Cargo 命令。

首次安装依赖：

```powershell
Set-Location app
pnpm install --frozen-lockfile
```

启动开发应用：

```powershell
pnpm tauri dev
```

## 变更流程

实质性功能、缺陷修复、重构、数据库/库格式变更、构建或发布变更，都必须先建立 OpenSpec change：

```powershell
openspec new change <verb-noun>
openspec status --change <change-id>
```

按 proposal → specs → design（需要时）→ tasks 完成产物，再逐项实施。每项任务通过验证后立即更新 `tasks.md`；归档前必须通过严格校验。

仅修改不影响运行行为的文字、注释或格式时，可以说明原因后不创建 change。

## 提交前门禁

以下命令必须在 `app/` 中按顺序执行，不要和 Rust 全量编译并行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

OpenSpec 严格校验在仓库根目录执行：

```powershell
openspec validate --all --strict --no-interactive
```

## README、截图和文档

新增截图必须使用匿名 fixture 或你有权公开的素材，存放在 `docs/assets/`，并提供中文 alt 文本。不要把个人素材、真实用户库或本机路径放进 README、Issue、PR 或测试报告。

## 提交 Pull Request

1. 从最新 `main` 创建 `codex/` 或功能分支。
2. 一个 PR 聚焦一个 OpenSpec change；说明变更目的、测试命令和已知限制。
3. 在 PR 描述中列出未运行的检查及原因，不要用“应该可以”代替证据。
4. 等待 GitHub CI 通过后再请求合并；不要修改或覆盖已推送的版本 tag。

## 许可证

Vistash 自有代码和明确归属的项目文档使用根目录 MIT License。第三方依赖、字体、图标和外部素材仍受各自许可证约束；提交新资产时请同时提供来源和许可证信息。
