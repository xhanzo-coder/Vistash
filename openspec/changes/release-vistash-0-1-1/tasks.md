## 1. 版本同步与候选构建

- [x] 1.1 将 `package.json`、Cargo workspace 和 `tauri.conf.json` 同步为 `0.1.1`，并用发布契约确认 `com.vistash.app` 与 `v0.1.0` 不变
- [x] 1.2 在当前 `main` 串行通过 `pnpm lint`、`pnpm typecheck`、`pnpm test`、Rust Clippy、Rust 测试和 OpenSpec strict validate
- [x] 1.3 构建 NSIS 与 MSI `0.1.1` 测试候选，生成并复核 SHA-256 清单，确认未签名状态只用于测试
- [x] 1.4 在隔离配置和测试库中启动 0.1.1，确认已有图片—提示词关系可读且安装/重装/卸载不删除用户数据

## 2. 标签与草稿发布

- [x] 2.1 更新版本发布记录，记录候选文件、工具版本、摘要、用户交互验收和公开前置条件
- [x] 2.2 从最新 `main` 创建受 ruleset 保护的 annotated `v0.1.1`，不移动或覆盖 `v0.1.0`
- [x] 2.3 等待 `v0.1.1` Windows workflow 完成门禁、双安装器、SHA-256 和草稿 Release，复核资产恰好完整

## 3. 终审与归档

- [x] 3.1 运行 Standards/Spec 双轴 code review，修复阻断项并记录最终结论
- [x] 3.2 通过 OpenSpec 全量 strict validate，将 delta spec 同步到 `windows-release-management` 主规格
- [ ] 3.3 归档 `release-vistash-0-1-1`，保留草稿未公开和签名待后续的边界
