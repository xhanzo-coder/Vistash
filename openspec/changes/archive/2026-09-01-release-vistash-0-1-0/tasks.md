## 1. 发布契约与安装器配置

- [x] 1.1 新增版本、identifier、bundle 目标与 tag 一致性验证脚本，并用 Node 测试覆盖成功、版本冲突、非法 tag 和配置缺失
- [x] 1.2 将 Tauri bundle 配置为同时生成 NSIS 与 MSI，保留 `com.vistash.app`、按使用者安装和默认 WebView2 策略
- [x] 1.3 新增 NSIS/MSI 唯一性与 SHA-256 清单脚本，并以临时匿名产物测试缺失、重复、版本不匹配和稳定排序

## 2. CI 与标签发布

- [x] 2.1 新增 PR/`main` Windows CI，按仓库要求串行运行前端与 Rust 四类门禁
- [x] 2.2 新增 `vX.Y.Z` 标签发布工作流，在构建前验证版本/tag/OpenSpec，生成 NSIS、MSI、校验和并创建草稿 GitHub Release
- [x] 2.3 静态验证 workflow 触发器、权限、工作目录、锁文件安装和失败即停止语义，不在本地创建远程 tag 或 Release
- [x] 2.4 修复内置 token 隐藏 ruleset bypass 字段的误判，新增按既有不可变标签手动重跑的恢复入口，并以 `v0.1.0` 完成草稿 Release

## 3. 发布运行手册

- [x] 3.1 编写 `docs/releasing.md`，记录 SemVer、分支/提交/tag、候选与正式版、SmartScreen、签名凭据、热修复和回滚纪律
- [x] 3.2 记录安装/同版本重装/补丁升级/卸载的数据保留矩阵与隔离路径，明确安装器不得删除 AppData 或素材库
- [x] 3.3 记录 updater 的后续独立变更边界、密钥备份与 HTTPS 要求，并验证 0.1.0 不含 updater 依赖、权限或配置

## 4. 本机 0.1.0 候选验证

- [x] 4.1 串行通过版本验证、`pnpm lint`、`pnpm typecheck`、`pnpm test`、Rust Clippy、Rust 测试与 OpenSpec strict validate
- [x] 4.2 在当前 Windows 主机生成未签名 NSIS 与 MSI 0.1.0 候选，并生成、复核 SHA-256 清单
- [x] 4.3 在隔离 Windows 配置和测试库中执行安装、启动、同版本重装、卸载、重新安装与数据保留验收，不触碰真实使用者配置
- [x] 4.4 记录本机候选文件、摘要、工具版本、SmartScreen/签名状态和剩余人工发布前置条件

## 5. 终审与交付

- [x] 5.1 运行 `code-review`，修复 Standards 与 Spec 阻断项并重新执行相关测试
- [x] 5.2 严格校验 release change，确认没有创建 tag、远程 Release、证书或 updater 私钥
- [x] 5.3 经用户确认 0.1.0 候选后，才能在清洁且已合并的 `main` 提交上创建 `v0.1.0` 标签；本任务在未授权前保持未完成
