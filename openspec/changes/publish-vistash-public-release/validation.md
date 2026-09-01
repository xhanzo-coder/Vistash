# Vistash v0.1.1 公开预览发布验证

日期：2026-09-01。当前 change 只修改公开沟通材料和 GitHub Release 可见性，不修改运行时代码、库格式、tag 或 updater。

## 已有前置证据

- `v0.1.1` 是受 `immutable-version-tags` 保护的 annotated tag，解析到已合并 `main` 提交 `a8e8fd10a879fa5021b5776dbd72f0b7bc3d41f8`。
- Windows Release workflow `33478622218` 成功完成前端 lint/typecheck/test、Rust Clippy/test、OpenSpec strict、NSIS/MSI 构建和 SHA-256 清单。
- 公开前的远程草稿 Release 包含恰好三个资产：NSIS、MSI 和 `SHA256SUMS.txt`；公开后资产未改变。
- 真实 Windows 桌面 11.5 验收、0.1.0→0.1.1 隔离升级、同版本重装、卸载与数据保留均已通过。

## README 与发布说明

- 根目录 `README.md`：已合并到 `main`，GitHub README API 可读取，链接、命令、功能边界、隐私说明和未签名风险已复核。
- `docs/releases/v0.1.1.md`：已用于 Release 正文，版本和 SHA-256 与远程 `SHA256SUMS.txt` 一致。
- `docs/releasing.md`：已补充公开预览转公开命令、失败撤回和正式签名边界。

## 未签名边界

当前没有可信 Authenticode 证书或签名服务凭据。公开对象只能称为“未签名公开预览”，不得声称已签名稳定分发。仓库不包含证书、密码、token、Git signing 私钥或 updater 私钥。

## 公开结果

- PR #12 的 Windows 工程门禁运行 `33490614999` 成功（5 分 35 秒）；合并提交为 `b4385ed4dc94b099c2bc5e138228b5ae2f9687dd`。
- `v0.1.1` 已转换为公开、非预发布 Release：[`Vistash v0.1.1`](https://github.com/xhanzo-coder/Vistash/releases/tag/v0.1.1)，`isDraft=false`、`isPrerelease=false`，标题为 `Vistash v0.1.1 — 公开预览`。
- 正文首屏明确未签名 SmartScreen 风险，并链接根目录 README；公开 Release 资产仍恰好为一个 NSIS、一个 MSI 和一个 `SHA256SUMS.txt`。
- 远程资产摘要未改变：NSIS `d4e5ca838788a74e103b65ffdc12ccb6bebc9cbe120ed64c2d2e2209d4d124f9`（3,790,988 字节）、MSI `57034d7328829eba26ff6bb6b6439dc16b501bd0d5214e05cad8bb15d06a6cae`（4,960,256 字节）、清单 `281200804574ec4421e0629fd1ea7f8584498524276839a471e0dd185bb84e4d`（188 字节）。
- `v0.1.0` 与 `v0.1.1` tag 均未改变；`v0.1.0` 旧 Release 仍保持草稿状态。
- 正式 Authenticode 签名仍未完成；本次公开对象严格称为“未签名公开预览”，没有上传任何签名凭据。
