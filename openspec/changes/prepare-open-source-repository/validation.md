# Vistash 开源仓库治理验证

日期：2026-09-01。变更范围为许可证、社区文件、README 展示资产、公开路径匿名化、第三方归属和 GitHub 仓库设置；不修改运行时业务行为。

## 许可证与元数据

- 根目录 `LICENSE` 使用 OSI 标准 MIT 文本，著作权标识为 `2026 xhanzo-coder`，未加入非商业或领域限制。
- `README.md`、`app/package.json`、Cargo workspace、`vistash-core` 和 Tauri crate 的机器可读许可证均为 `MIT`。
- `cargo metadata --format-version 1` 已确认两个 Vistash crate 返回 `license=MIT`；`pnpm` 包元数据返回 `license=MIT`。

## 社区入口

- `.github/CONTRIBUTING.md`：环境、目录边界、OpenSpec、串行门禁、资产来源和 PR 流程。
- `.github/SECURITY.md`：私下安全报告入口和敏感信息脱敏要求。
- `.github/ISSUE_TEMPLATE/bug_report.yml`、`feature_request.yml`：已用 PyYAML 解析通过。
- `.github/PULL_REQUEST_TEMPLATE.md`：包含测试、OpenSpec、隐私和 tag 检查。
- `.github/dependabot.yml`：npm、Cargo 和 GitHub Actions 周期更新配置。
- 当前没有添加 `CODE_OF_CONDUCT.md`，原因是尚未确定可执行的行为问题联系人；不提交空泛模板。

## README 展示资产

- `docs/assets/vistash-icon-256.png` 与 `app/src-tauri/icons/256x256.png` SHA-256 一致。
- `docs/assets/screenshots/` 的欢迎页、图片工作区、提示词工作区、多图关联截图与对应匿名验收源文件 SHA-256 一致。
- README 所有图片均使用稳定 `docs/assets/` 路径、中文 alt 文本，并注明匿名测试数据；未引用 prototype 目录或个人素材。

## 路径、凭据与归属审计

- 当前仓库扫描未发现开发者用户名、个人媒体库路径或中央 Skill 绝对路径；通用 `E:\vistash-release-e2e` 测试根路径保留用于复现。
- 当前工作树及 Git 历史模式扫描未发现私钥、GitHub token、模型 API Key、密码或凭据文件；本次不执行历史重写。
- `pnpm licenses list --prod --json` 与 `cargo metadata --format-version 1` 已完成；发布依赖以 MIT 或 Apache-2.0 双许可为主，开发树中的 MPL-2.0、BlueOak-1.0.0、BSD、ISC、CC0 和 0BSD 不被根 MIT 覆盖。
- `THIRD_PARTY_NOTICES.md` 已记录直接发布依赖、开发依赖许可证族和 Vistash 自有图标/截图边界；未创建空 `NOTICE`。

## GitHub 设置

- 仓库 description：`Windows 优先、本地优先的图片素材与提示词工作台。`
- topics：`image-management`、`local-first`、`prompt-management`、`react`、`rust`、`sqlite`、`tauri`、`windows`。
- Secret Scanning、Push Protection、Dependabot security updates、vulnerability alerts 和 private vulnerability reporting 已启用。
- `main` 仍为默认分支；不可变版本 tag ruleset 未改变。
