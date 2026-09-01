# Vistash

> Windows 优先、本地优先的图片素材与提示词工作台。

Vistash 把图片、提示词和它们之间的可选关系放在同一个本地素材库里。它适合需要长期整理视觉参考、反复复用提示词、并希望保留文件原始身份的创作者。

[![CI](https://github.com/xhanzo-coder/Vistash/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xhanzo-coder/Vistash/actions/workflows/ci.yml)
[![最新公开预览](https://img.shields.io/badge/preview-v0.1.1-e8664a)](https://github.com/xhanzo-coder/Vistash/releases/tag/v0.1.1)

> ⚠️ **v0.1.1 是未签名的公开预览版。** Windows 可能显示 SmartScreen 警告。请从本 README 或 GitHub Release 下载，并在安装前核对 SHA-256；正式 Authenticode 签名将在后续发布流程中单独完成。

## 它解决什么问题

图片参考、提示词正文和最终使用的文件名经常散落在文件夹、聊天记录和临时笔记里。Vistash 提供一个可搜索、可复用、可回溯的本地工作台：

- 图片保留内容哈希身份，文件名可以编辑但不会改写来源身份。
- 提示词可以独立保存、搜索、收藏、复制和放入提示词文件夹。
- 一条提示词可以关联多张图片，并用一张封面和缩略图列表表达这组视觉参考。
- 图片和提示词都支持可恢复回收站，解除关联不会删除任意一方素材。
- 图片进入库后默认只在本机处理，源文件不会被移动、删除或改写。

## 当前版本能做什么

### 图片工作区

- 从文件选择器、文件夹选择器、资源管理器拖放或 Windows 剪贴板导入图片。
- 文件夹导入递归保留逻辑层级，重复素材按内容哈希识别，非图片文件计入跳过结果。
- 用文件夹、标签、收藏、文件名和回收站范围组织与检索图片。
- 使用原画幅比例的瀑布流或详情列表浏览，单击查看检查器，双击进入灯箱。
- 编辑显示文件名，同时保留不可变的来源文件名和真实扩展名。
- 复制单张图片到剪贴板、用 Windows 默认程序打开只读副本、导出原图并处理同名冲突。
- 将图片移动到唯一逻辑文件夹或未分类；删除进入库内回收站，确认后才永久清空。

### 提示词工作区

- 创建、编辑、复制、收藏和删除提示词素材。
- 按标题、正文、标签、提示词文件夹和回收站状态检索。
- 在图片页面创建提示词，或把已有提示词关联到当前图片。
- 在提示词页面查看全部关联图片：主预览、缩略图列表、显示文件名、文件夹和尺寸。
- 直接解除图片—提示词关联；解除关系不会删除图片或提示词。

### Windows 工作流

- 自定义紧凑标题栏：拖动、双击最大化/还原、最小化、关闭和 Windows 贴靠。
- 中等和窄窗口优先保留中央内容，导航与检查器按需折叠或覆盖。
- 深色、浅色和跟随系统三种主题，键盘焦点和文本粘贴保持 Windows 习惯。

## 典型使用流程

1. 启动 Vistash，创建新库或打开已有库。
2. 把参考图片拖入图片工作区，或使用顶栏“导入”。
3. 用文件夹、标签和搜索缩小图片集合；单击图片查看检查器。
4. 在图片检查器的“关联提示词”区域选择已有提示词，或直接创建一条提示词。
5. 打开提示词工作区，查看这条提示词的主预览和全部关联图片；需要时切换缩略图或解除关联。
6. 使用复制、默认程序打开或导出，把素材交给其他创作工具。

## 安装

前往 [v0.1.1 公开预览 Release](https://github.com/xhanzo-coder/Vistash/releases/tag/v0.1.1)，选择一种 Windows 安装器：

- **NSIS setup EXE**：适合大多数使用者，双击即可安装。
- **MSI**：适合需要 Windows Installer 的管理或部署场景。

下载后建议先在 PowerShell 核对哈希：

```powershell
Get-FileHash .\Vistash_0.1.1_x64-setup.exe -Algorithm SHA256
Get-FileHash .\Vistash_0.1.1_x64_en-US.msi -Algorithm SHA256
```

当前公开预览资产的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `Vistash_0.1.1_x64-setup.exe` | `d4e5ca838788a74e103b65ffdc12ccb6bebc9cbe120ed64c2d2e2209d4d124f9` |
| `Vistash_0.1.1_x64_en-US.msi` | `57034d7328829eba26ff6bb6b6439dc16b501bd0d5214e05cad8bb15d06a6cae` |

安装器目前没有 Authenticode 签名，因此 Windows 的“Windows 已保护你的电脑”提示属于预期风险。只有在你确认下载来源和 SHA-256 后，才应选择继续安装。

## 数据、隐私与备份

- **本地优先**：图片、提示词、缩略图、侧车元数据和索引保存在你选择的本地库目录中。
- **源文件不动**：导入是复制入库，不会移动、删除或改写库外源文件。
- **无账号、无云同步**：当前版本不要求登录，不把素材上传到 Vistash 服务，也不提供云同步。
- **设置位置**：Windows 应用设置位于 `%APPDATA%\com.vistash.app`；素材库路径由你在应用中选择。
- **卸载保留数据**：卸载程序文件不会删除设置或你选择的素材库；重新安装后可以继续打开。
- **建议备份**：关闭 Vistash 后，定期复制整个素材库目录到备份盘。不要只备份 SQLite 文件，图片本体、侧车和缩略图共同构成可恢复的库。

## 当前明确不支持

`v0.1.1` 是图片与提示词管理的公开预览，不包含以下能力：

- 图像反推提示词、图像生成或模型 provider 配置。
- 从单张成图恢复历史原始提示词字符串。
- 网页站点批量抓取、浏览器扩展、内置浏览器采集或网址下载。
- 云同步、账号体系、团队协作、在线图库或自动更新。
- 智能文件夹、相似搜索、EXIF 检索、图片编辑、评分体系和通用撤销历史。
- macOS/Linux 正式支持。当前公开预览以 Windows 桌面行为为验收目标。

Vistash 的长期目标是“生成能在指定生图模型上重建相似视觉语言的控制提示词”；这不是 `v0.1.1` 已提供的功能，也不应被理解为恢复过往生成记录。

## 从源码运行

开发环境需要：

- Windows、Node.js、pnpm；
- Rust stable MSVC toolchain 与 Visual Studio 生成工具；
- WebView2 Runtime。

在 `app/` 目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

完整门禁必须串行执行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Windows 发布流程、隔离安装生命周期、SHA-256 清单和签名边界见 [`docs/releasing.md`](docs/releasing.md)。

## 项目结构

- `app/`：Tauri 2、React/TypeScript、Rust 和 SQLite 应用。
- `app/src/features/assets/`：图片工作区的实现。
- `app/src/features/prompts/`：提示词工作区的实现。
- `app/src-tauri/`：Tauri 窗口、IPC 和平台能力。
- `openspec/`：产品规格、工程决策和验收记录。
- `docs/`：发布和维护文档。

Vistash 的图片像素处理、缩放、缩略图和色卡分析在 Rust 侧完成；界面层不读取像素缓冲，也不内置模型供应商密钥。

## 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/xhanzo-coder/Vistash/issues) 报告可复现的问题或提出建议。反馈时请尽量包含：

1. Vistash 版本和 Windows 版本；
2. 复现步骤与预期/实际结果；
3. 是否使用 NSIS 或 MSI；
4. 稳定错误码、日志或最小化后的截图。

请不要在 issue、日志或截图中上传素材库、API 密钥、签名凭据或个人图片。

## 许可证

仓库当前尚未提交 `LICENSE` 文件。仓库公开可见不等同于已经授予开源、再分发或商用许可；在许可证正式确定前，如需复制、再分发或商用，请先联系项目维护者。
