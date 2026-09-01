## Why

当前 `main` 已包含最新的图片—提示词关系管理修复，但不可变的 `v0.1.0` 标签和草稿安装包仍对应旧交互。需要发布一个只包含兼容修复的 `0.1.1` 测试候选，让测试安装包与用户已经验收的界面一致。

## What Changes

- 将 `package.json`、Cargo workspace 和 `tauri.conf.json` 的应用版本同步为 `0.1.1`。
- 从最新 `main` 串行通过前端/Rust/OpenSpec 门禁，构建 NSIS 与 MSI 测试安装包并生成 SHA-256 清单。
- 以受 `immutable-version-tags` 保护的 annotated `v0.1.1` 标签触发草稿 GitHub Release；不移动或覆盖 `v0.1.0`。
- 在隔离 Windows 配置中验证 0.1.1 安装、启动、同版本重装、补丁升级、卸载和数据保留。
- 发布说明继续标记未签名测试候选与 SmartScreen 风险；不接入 updater 或 Authenticode 私钥。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `windows-release-management`：增加 0.1.1 版本同步、候选验证与不可变 tag 草稿发布记录。

## Impact

- 版本文件：`app/package.json`、`app/Cargo.toml`、`app/src-tauri/tauri.conf.json`。
- 发布验证与 OpenSpec validation 记录；不改变运行时数据格式、identifier 或关系模型。
- GitHub tag、Actions 草稿 Release 和本机 `app/target/release/bundle/` 产物。
