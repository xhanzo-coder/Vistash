# Vistash v0.1.1 公开预览发布验证

日期：2026-09-01。当前 change 只修改公开沟通材料和 GitHub Release 可见性，不修改运行时代码、库格式、tag 或 updater。

## 已有前置证据

- `v0.1.1` 是受 `immutable-version-tags` 保护的 annotated tag，解析到已合并 `main` 提交 `a8e8fd10a879fa5021b5776dbd72f0b7bc3d41f8`。
- Windows Release workflow `33478622218` 成功完成前端 lint/typecheck/test、Rust Clippy/test、OpenSpec strict、NSIS/MSI 构建和 SHA-256 清单。
- 远程草稿 Release 当前包含恰好三个资产：NSIS、MSI 和 `SHA256SUMS.txt`。
- 真实 Windows 桌面 11.5 验收、0.1.0→0.1.1 隔离升级、同版本重装、卸载与数据保留均已通过。

## README 与发布说明

- 根目录 `README.md`：待发布分支合并后复核链接、命令、功能边界、隐私说明和未签名风险。
- `docs/releases/v0.1.1.md`：待用于 Release 正文，版本和 SHA-256 必须与远程 `SHA256SUMS.txt` 一致。
- `docs/releasing.md`：已补充公开预览转公开命令、失败撤回和正式签名边界。

## 未签名边界

当前没有可信 Authenticode 证书或签名服务凭据。公开对象只能称为“未签名公开预览”，不得声称已签名稳定分发。仓库不包含证书、密码、token、Git signing 私钥或 updater 私钥。

## 公开后待核对

- Release `isDraft=false`，标题为 `Vistash v0.1.1 — 公开预览`。
- 正文首屏明确未签名 SmartScreen 风险，并链接 README。
- 三个资产名称、字节数和 SHA-256 未改变，`v0.1.0` 与 `v0.1.1` tag 未改变。
- GitHub 仓库根页面能够直接打开 README，README 中的 Release/Issues 链接有效。
