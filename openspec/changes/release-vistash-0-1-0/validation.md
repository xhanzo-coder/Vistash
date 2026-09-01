# Vistash 0.1.0 Windows 候选验证

日期：2026-08-31。当前结果是本机未签名测试候选，不是正式 GitHub Release。

## 来源与工具链

- Git HEAD：`4e1290dc03ca625fc22f4a275914b8a1a82de55f`。
- 分支：`agent/redesign-image-library-workspace`。
- 候选包含当前未提交工作树，因此只能用于本轮安装验收；提交、合并与清洁 `main` 后必须由标签工作流重新构建，不能直接上传本机文件。
- Node.js `24.12.0`，pnpm `10.3.0`。
- rustc `1.97.1`，cargo `1.97.1`，Tauri CLI `2.11.4`。
- Windows 11 x64；Tauri 首次 bundle 下载并校验 NSIS `3.11`、`nsis_tauri_utils 0.5.3` 与 WiX `3.14.1`。

## 串行门禁

- `pnpm release:verify`：通过，三处版本均为 `0.1.0`，identifier 为 `com.vistash.app`，bundle 目标为 `msi,nsis`，未发现 updater 依赖、插件或权限。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：48 个 Vitest 文件、429 项通过；25 项 Node 合同测试通过，其中发布契约 6 项、workflow 合同 2 项。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：Tauri crate 12 项、核心 crate 304 项、剪贴板/导出/外部打开/导入/迁移/sidecar 等集成测试与文档测试全部通过。
- `openspec validate --all --strict --no-interactive`：9 个主规格/活动变更全部通过。

## 安装器与摘要

`pnpm release:build` 从同一次 release 编译生成：

| 文件 | 字节数 | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `Vistash_0.1.0_x64-setup.exe` | 29,103,012 | `320bb4e6f5316baf063d29e642dc2e2ed467f057c3374c2410f0b4d1017b3d98` | `NotSigned` |
| `Vistash_0.1.0_x64_en-US.msi` | 34,181,120 | `57567ea708764b3dd95900095b8e7b89058ff6272d0ae0e5fca87b653e52aba4` | `NotSigned` |

`app/target/release/bundle/SHA256SUMS.txt` 由发布脚本从两个唯一候选生成并复核。两种安装器均未数字签名，符合“受控测试候选”边界；公开分发前必须完成 Authenticode 决策和重新构建。

## NSIS 真实安装生命周期

命令：

```powershell
node scripts/installer-lifecycle.mjs --nsis target/release/bundle/nsis/Vistash_0.1.0_x64-setup.exe --upgrade-nsis E:\vistash-release-e2e\upgrade-candidates\Vistash_0.1.1_x64-setup.exe
```

验收脚本在操作前确认 `%LOCALAPPDATA%\Vistash` 不存在、没有遗留配置备份，并把真实 `%APPDATA%\com.vistash.app` 原子改名保护；测试配置只指向 `E:\vistash-installer-lifecycle\library` 的基线副本。结果：

- 静默按使用者安装成功；安装后的 `vistash.exe` 通过独立 WebView2 CDP 端口接受检查，页面实际进入未隐藏的图片工作区、显示“全部图片”，素材库切换器为“library”，不是只判断进程存活；
- 同版本静默重装成功，隔离 `settings.json` 字节不变，并在进入 patch 升级前单独再次启动、通过 CDP 重新打开兼容库；
- 通过 Tauri `--config '{"version":"0.1.1"}'` 从同一源码生成仅供升级矩阵使用的 NSIS，0.1.0→0.1.1 后已安装可执行文件 SHA-256 确实变化，隔离设置不变，并再次通过 CDP 证明兼容库已重新打开；
- 静默卸载成功，AppData 与库副本仍存在；
- 卸载后重新安装 0.1.1 与再次打开隔离库成功，设置仍不变；
- 最终再次卸载，`%LOCALAPPDATA%\Vistash` 不存在；
- 真实 AppData 已恢复，`.installer-lifecycle-backup` 不存在；隔离目录已删除。

首次运行发现 NSIS 卸载器进程返回后仍需短暂自删除，立即检查会误报安装目录残留。验收脚本改为最多 10 秒的 100ms 有界轮询；同一真实生命周期命令随后稳定通过。另一次失败来自测试错误假设元数据名为 `vistash-library.json`，而冻结基线权威文件为 `library.json`；修正断言后通过。两处均为验收脚本缺陷，不是产品数据删除缺陷。

测试升级包移动到 `E:\vistash-release-e2e\upgrade-candidates\Vistash_0.1.1_x64-setup.exe`，大小 29,108,612 字节，SHA-256 为 `d36e017697fd4b30604f1526a6b538b456e2235c26026300f7795d35b9aadbe7`；它不属于 0.1.0 发布产物，已移出正式 bundle 目录。MSI 已完成实际 bundle、唯一性和哈希验证；本轮没有在当前使用者会话执行 MSI 的 per-machine 安装，以免引入管理员级系统变更。正式发布前仍应在专用 Windows 测试账户或 VM 补一次 MSI 安装/卸载矩阵。

## 仍需发布前确认

- 图片工作区 change 的 11.5 仍需使用真实鼠标从 Explorer 拖入一个图片文件夹；自动化跨窗口拖动没有产生 Explorer OLE 文件载荷，不能冒充通过。
- 在专用 Windows 测试账户或 VM 完成 MSI 安装/卸载与数据保留复验。
- 选择并配置可信 Authenticode 方案，同时签名 NSIS 与 MSI；当前候选会触发 SmartScreen 风险。
- 在 GitHub 启用无 bypass 的 active tag ruleset，目标包含 `refs/tags/v*`、没有 exclusion，并限制 update/deletion；发布工作流会在构建前读取并强制这些条件。
- 完成提交、合并到清洁 `main`，由标签工作流重新构建；当前本机候选不得上传。
- 用户确认候选后才创建 `v0.1.0` 签名 tag。本轮没有创建或推送 tag，没有创建 GitHub Release，也没有生成证书或 updater 私钥。
