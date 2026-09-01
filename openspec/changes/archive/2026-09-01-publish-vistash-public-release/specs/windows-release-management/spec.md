## ADDED Requirements

### Requirement: 公开预览发布与新用户说明

已完成真实验收的版本 MAY（可以）从草稿 Release 转为公开预览，但公开 Release MUST（必须）保留与不可变 tag 相同的 NSIS、MSI 和 SHA-256 清单，并在标题或正文首屏明确版本性质、未签名 SmartScreen 风险、数据本地存储边界和正式签名尚未完成。公开预览 MUST NOT（禁止）声称已签名、已通过 Windows 信任验证或启用了自动更新。仓库根目录 MUST（必须）提供简体中文 README，说明产品定位、当前能力、安装方式、数据与隐私、明确不支持的范围和反馈入口。

#### Scenario: 将已验收草稿公开

- **WHEN** 项目所有者确认 `v0.1.1` 的 Windows 桌面验收、资产哈希和 OpenSpec 门禁均通过
- **THEN** `v0.1.1` 草稿可以转换为公开预览，且资产仍恰好为一个 NSIS、一个 MSI 和一个 `SHA256SUMS.txt`
- **AND** Release 正文首屏明确“未签名公开预览”和 SmartScreen 风险，不改变 `v0.1.0` 或 `v0.1.1` tag

#### Scenario: 没有签名凭据时公开

- **WHEN** 发布环境没有可信 Authenticode 证书或签名服务凭据
- **THEN** 公开 Release 与 README 明确说明安装器未签名、Windows 可能显示 SmartScreen 警告
- **AND** 不上传私钥、证书密码、签名 token，不声称正式稳定分发已完成

#### Scenario: 新用户阅读项目说明

- **WHEN** 新用户打开仓库根目录 README
- **THEN** 可以从 README 找到产品定位、图片与提示词工作区能力、安装入口、首次使用路径、本地数据/隐私说明、当前不支持的能力和问题反馈入口
- **AND** README 不承诺网页抓取、云同步、自动更新或恢复历史原始提示词
