# Vistash 安全政策

## 支持范围

当前重点支持公开的 `v0.1.2` 预览版和 `main` 分支。`v0.1.2` 安装器是未签名公开预览，Windows SmartScreen 警告不属于安全漏洞。

## 报告漏洞

请不要在公开 Issue、PR、截图或日志中粘贴漏洞利用步骤、个人素材库、路径、凭据或其他敏感信息。优先使用 GitHub 的私下安全报告入口：

[提交私下安全报告](https://github.com/xhanzo-coder/Vistash/security/advisories/new)

报告应包含受影响版本、Windows 版本、最小复现步骤、影响范围和安全地验证问题所需的最少附件。若私下报告入口暂不可用，请只创建一个不包含细节的公开 Issue，请维护者启用私下沟通，不要在 Issue 中继续披露内容。

维护者会在有条件时确认收到报告，并在修复、缓解或决定不修复后更新处理状态；当前项目不承诺固定响应时限。

## 不属于漏洞报告的事项

- 一般功能问题和 UI 建议：请使用 [Issues](https://github.com/xhanzo-coder/Vistash/issues)；
- 安装器 SmartScreen 警告：请先核对 Release 中的 SHA-256，并在反馈中注明安装器类型；
- 依赖许可证或第三方归属问题：请在 Issue 中提供依赖名称和许可证来源，不要复制完整源码。

请不要把真实素材库上传到任何报告渠道。必要时使用可公开的最小匿名 fixture 重现问题。
