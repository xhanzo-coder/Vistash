# Vistash 0.1.1 测试候选验证

日期：2026-09-01。候选基于最新 `main` 的图片—提示词关系管理修复，当前只用于测试；GitHub Release 保持草稿，不公开下载。

## 版本与工程门禁

- `app/package.json`、`app/Cargo.toml` 的 `[workspace.package]` 和 `app/src-tauri/tauri.conf.json` 均为 `0.1.1`。
- `com.vistash.app` 保持不变；旧 `v0.1.0` tag 未移动、未覆盖。
- `pnpm release:verify`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：48 个 Vitest 文件、431 项通过；26 项 Node 合同测试通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：Tauri crate 12 项、核心 crate 304 项及全部集成/文档测试通过。
- `openspec validate --all --strict --no-interactive`：全部通过。

## 安装器

| 文件 | 字节数 | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `Vistash_0.1.1_x64-setup.exe` | 29,471,240 | `5fcb597f216c96926c580ce6d856898274d85717e8e48fceef9492ec00128275` | `NotSigned` |
| `Vistash_0.1.1_x64_en-US.msi` | 34,918,400 | `85262d33c2eafd996c49977bd09dc729b34e4fb6e03f52deb03d5d226c286548` | `NotSigned` |

清单位于 `app/target/release/bundle/SHA256SUMS.txt`。未签名状态符合受控测试候选边界，Windows 可能显示 SmartScreen 警告。

## 标签与远程草稿 Release

- `v0.1.1` 是受 `immutable-version-tags` ruleset 保护的 annotated tag；tag object 为 `b4e6300935a81d12b5f7dde57fd245257c50b4a0`，解析到 `main` 提交 `a8e8fd10a879fa5021b5776dbd72f0b7bc3d41f8`。
- Windows Release workflow：`33478622218`（[运行记录](https://github.com/xhanzo-coder/Vistash/actions/runs/33478622218)），耗时 10 分 20 秒，全部门禁和打包步骤通过。
- 草稿 Release：`Vistash v0.1.1`（[草稿页面](https://github.com/xhanzo-coder/Vistash/releases/tag/untagged-f8e709fa32eeea5509e6)），资产恰好为一个 NSIS、一个 MSI 和一个 `SHA256SUMS.txt`。

远程 Release 资产摘要如下；哈希与工作流生成的 `SHA256SUMS.txt` 一致：

| 文件 | 远程字节数 | SHA-256 |
| --- | ---: | --- |
| `Vistash_0.1.1_x64-setup.exe` | 3,790,988 | `d4e5ca838788a74e103b65ffdc12ccb6bebc9cbe120ed64c2d2e2209d4d124f9` |
| `Vistash_0.1.1_x64_en-US.msi` | 4,960,256 | `57034d7328829eba26ff6bb6b6439dc16b501bd0d5214e05cad8bb15d06a6cae` |
| `SHA256SUMS.txt` | 188 | `281200804574ec4421e0629fd1ea7f8584498524276839a471e0dd185bb84e4d` |

## 隔离安装生命周期

命令：

```powershell
node scripts/installer-lifecycle.mjs --nsis E:\vistash-release-e2e\local-0.1.0-candidates\Vistash_0.1.0_x64-setup.exe --upgrade-nsis E:\vistash-release-e2e\upgrade-candidates\Vistash_0.1.1_x64-setup.exe
```

结果：以本地 `0.1.0` NSIS 作为初始包、以本地 `0.1.1` NSIS 作为升级包，在隔离配置下安装、启动并通过 WebView2 CDP 确认进入图片工作区且打开 `library` 测试库；同版本重装、补丁升级、卸载后重装均再次打开成功，设置与素材库均保留。测试结束后真实 `%APPDATA%\com.vistash.app` 已恢复，隔离目录已删除；该 `0.1.1` 升级包与远程草稿来自同一版本提交的本地构建候选。

## 用户交互验收

用户已完成当前测试安装包的主要验收：图片页直接解除提示词关联、提示词页直接解除图片关联、多图提示词单封面＋总数展示。此前自动化视觉矩阵覆盖 18 个匿名状态，控制台错误和水平溢出均为 0。

## 发布边界

- `v0.1.1` tag 和 GitHub 草稿 Release 已创建；草稿仍未公开，旧 `v0.1.0` tag 和草稿未移动、未覆盖。
- 草稿资产来自 tag workflow 的清洁 `main` 提交，不复用本机旧候选。
- 公开发布前仍需 Authenticode 签名决策；updater 继续不启用。
- 图片工作区的 11.5 仍有真实 Explorer 文件夹拖放人工项，独立于本 patch release change。
