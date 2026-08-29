# 图片导入入口验收（10.2）

日期：2026-08-29。承接 9.5、10.1 和 9.4 的成果，完成 10.2；当前变更进度为 74/75（仅 11.5 尚未完成）。

## 实现范围

- 文件选择、文件夹选择、剪贴板导入和空库引导均复用 `appPlatform` 与同一导入协调器。
- 文件夹选择使用新增的 `pickImportDirectory`，不复用库位置选择器；当前具体逻辑文件夹通过 `currentFolder` 传入。
- 入站任务注册 `TaskKind="import"` 与库级传输并发键。任务中心显示导入标题、传输进度、成功/跳过/失败/未处理计数与逐项错误码。
- 同库重复导入被稳定错误码 `transfer.already_running` 拒绝。文本框内的 Ctrl+V 保持普通粘贴；图片工作区活动且没有编辑控件获得焦点时才认领 Ctrl+V。
- 真实 Tauri metadata 存在时接收整窗口 `PlatformPort.onFileDrag`；普通浏览器开发入口不伪造原生环境。空集合显示导入引导并保留当前查询为空的明确文案。
- 首个进度保存后端 task ID。停止按钮和“正在停止”状态已接线，只有后端返回 `stopped` 且结果到达后才确认终态；完整冲突/停止报告在 10.3–10.4 已由同一任务中心扩展。

## 红—绿回归

测试仍从 `asset-library/index.ts` 公开 interface 渲染，在 IPC 系统边界模拟目录选择、导入结果和进度 channel。导入相关行为与停止竞态回归均已纳入图片模块测试，当前该文件 83 项：

1. 三种导入入口存在，剪贴板结果进入任务中心。
2. 图片/文件夹选择传入正确路径与当前逻辑文件夹。
3. 文本输入不认领 Ctrl+V，运行中的任务拒绝第二个任务；收到后端任务 ID 后停止状态等待后端确认。

同时更新 platform contract，两个 adapter 都覆盖独立的导入目录对话框结果。

## 浏览器验收

`app/scripts/import-entry-check.py` 使用 Python Playwright 与 Windows headless Edge，覆盖深/浅主题、1440×900/760×600。四组全部通过：文件选择、文件夹选择、剪贴板任务中心、文本框粘贴隔离、空结果导入引导和无水平溢出。测试只使用开发内存库，未访问真实素材。

整窗口原生拖放的 adapter contract 已由 `platform.contract.test.ts` 覆盖；Windows release 下的真实 Shell 拖放属于 11.5。

## 门禁

- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`：通过。最新 `pnpm test` 为 46 个文件、384 项 Vitest 与 17 项 Node 测试。
- 浏览器导入流程四组通过；临时 Vite 服务用于验收，完成后关闭。
- OpenSpec 严格校验、差异检查和 UTF-8 无 BOM 检查在本变更全部完成后重跑。

默认 App 已切换到新版 `AppShell` 与图片模块；release 原生拖放/剪贴板验收属于 11.5。
