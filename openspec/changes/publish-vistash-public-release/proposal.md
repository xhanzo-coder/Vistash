## Why

`v0.1.1` 已完成真实 Windows 桌面验收、安装生命周期验证和完整工程门禁，但 GitHub 草稿仍停留在“未签名测试候选”，仓库也没有面向新用户的 README。现在需要把已验收版本整理为可公开访问的预览发布，并让用户能够在下载前理解产品定位、数据边界、安装方式和已知限制。

## What Changes

- 新增完整简体中文 `README.md`，说明产品定位、图片与提示词工作区、图片—提示词多图关联、安装/开发入口、本地数据路径、隐私边界、当前不支持的能力和反馈方式。
- 更新 `docs/releasing.md`，补充公开预览发布前的验收、未签名风险、校验和核对、草稿转公开和后续签名升级流程。
- 将已验收的 `v0.1.1` GitHub 草稿 Release 转为公开预览 Release，保留 NSIS、MSI 和 `SHA256SUMS.txt` 三个资产，并在说明中明确未签名 SmartScreen 风险。
- 公开发布仍不启用 Tauri updater，不提交任何证书、密码、签名服务 token 或私钥。
- 保持 `v0.1.0`、`v0.1.1` 不可变 tag、库格式、用户配置路径和运行时代码不变。

## Capabilities

### New Capabilities

无。README 与发布说明属于公开沟通材料，不新增运行时能力。

### Modified Capabilities

- `windows-release-management`：明确已验收 patch 版本可作为标记清楚的公开预览发布；公开预览的未签名边界、资产完整性、校验和、旧 tag 隔离和正式签名前置条件必须可追溯。

## Impact

- 文档：新增根目录 `README.md`，更新 `docs/releasing.md` 与 OpenSpec 发布规格。
- GitHub：更新 `v0.1.1` Release 可见性和发布说明；不会移动或重建任何 tag。
- 构建与运行时：不修改 React、Rust、SQLite、Tauri command、库格式或 updater 配置。
- 安全：公开资产继续为未签名预览，必须显示 SmartScreen 风险；仓库不包含签名凭据。
