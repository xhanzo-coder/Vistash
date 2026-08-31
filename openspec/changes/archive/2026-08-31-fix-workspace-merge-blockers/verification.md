# 合并修复验收记录

日期：2026-08-27。修复基点：`31fdf6225a5a1cb363406f51b9a615b9b17bc515`。

## 红绿回归

- 原生订阅拒绝：原实现没有错误呈现；修复后选库/工作台持续显示关闭保护错误，关联区停止宣称可拖入。
- StrictMode：原实现“已保存”和失败错误码断言失败；setup 恢复挂载标记后通过。
- 查询切换：搜索、文件夹、标签、收藏、回收站、移除条件原实现均可绕过正文守卫；修复后取消/失败不切换，确认后才继续。
- 文件夹写入：复审发现先写后守卫仍可丢稿；真实路径过滤 fixture 证明原实现过早写入，统一写前守卫后取消/失败不写、放弃只写一次。
- 聚焦：两视图原本缺双击/Enter；补齐后通过。Windows 实测进一步发现焦点留在 body，新增实际 activeElement 上的 Esc 回归，挂载聚焦后通过。
- 框选：鼠标替换、Ctrl 追加/收缩、Esc/pointercancel、滚动包含离屏项、查询/宽度变化取消、单列、万项 DOM 有界均通过。
- 大范围框选：10,000 个 64 字符身份全部命中的原 reducer 实测约 900ms；一次 Set 查询替代重复线性查找后通过 50ms 回归门禁。
- 窗口关闭：真实 release 的 close 命令先因 ACL 被拒绝，后发现 SDK 的 destroy 也需要权限；main 最小授予两权限并显式处理销毁拒绝后，事件 SDK 回归与实际关闭均通过。

## 自动化检查

- `pnpm lint`、`pnpm typecheck`：通过。
- `pnpm test`：37 个 Vitest 文件、255 项测试与 4 项 Node 测试通过。
- `pnpm build`：通过；最终前端 JS gzip 约 105.87 kB。
- 最终正常标识 `pnpm tauri build --no-bundle` 构建通过，随后串行重跑 Rust Clippy、278 项核心与 6 项 Tauri 测试全部通过；核心测试耗时 267.85s，doc tests 零失败。
- 已知非阻断构建提示：Tauri window 同时被静态/动态导入；既有 `com.vistash.app` 标识的 macOS 后缀建议。本轮 Windows 优先，不改动既有应用身份。

## 真实浏览器

使用 `webapp-testing` 的服务生命周期工具与 Python Playwright 驱动 production 构建，复用万项 fixture：

| 场景 | 集合 DOM | 四次鼠标移动及结果断言耗时 |
| --- | --- | --- |
| 10,000 图片 | 12 | 36.61ms |
| 10,000 提示词 | 14 | 35.80ms |

该耗时包含四次输入和 Playwright 断言，不声称是单帧时间。页面错误为零。截图与 JSON 在 `app/artifacts/merge-blockers/`。

## Windows release

用 `pnpm tauri build --no-bundle --config scripts/merge-review.tauri.conf.json` 生成隔离标识 `com.vistash.merge-review-20260827` 的原生应用。脚本调用原生 identifier 接口确认隔离标识后，才在新临时目录建立库，绝不切换正式应用配置或复用使用者素材库。

真实 Rust IPC 创建 4 条合成提示词仅作为测试准备（不宣称新建 UI 已实现），随后全部通过界面进行：双击阅读、实际 Esc 返回、编辑正文、收藏筛选前取消、保存并继续筛选、读取权威正文验证落盘、卡片框选、详情列表 Enter、关闭窗口时保留草稿、放弃草稿后真正关闭窗口。页面错误为零；四次框选移动及断言约 33.73ms。

可复现入口：`python -X utf8 scripts/verify-merge-blockers.py --help`。原生实例须设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9226`；脚本用 `--cdp http://127.0.0.1:9226` 连接。浏览器模式用 `--url <production-preview-url>`。

## 界面准则复核

按 [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) 复核本轮变更：错误持续可见、聚焦模式接管键盘、Esc 不误清原选择、框线使用语义 token 且不拦截命中、无新动画、附属按钮保持原语义、虚拟化没有全量 DOM。保留既有临时视觉方案，不在本轮重新设计界面。

## Standards

最终复审 0 项发现。原生订阅和两个关闭阶段的错误均可见；权限仅授予 main；StrictMode 生命周期恢复；框选复杂度修正为 O(n+k)。

## Spec

最终复审 0 项发现。查询及组织写入均在执行前保护正文草稿；聚焦入口、实际焦点、框选和取消语义满足当前变更。新建提示词入口明确留在本轮之外。

汇总：Standards 0 项，Spec 0 项；没有剩余合并阻断。

## 同步到图片工作区重构分支

旧分支已通过 PR #3 普通 merge 合入 main，合并提交 `c190febd308bdb4b6c0dfd38a22fe42732f73964`，没有 squash、rebase 或改写历史。随后把 main 合入 `agent/redesign-image-library-workspace`，文本合并无冲突。

同步校验中将新增框选测试与性能 fixture 对齐该分支已经批准的 v3 `display_filename`／单一 `folder` 字段，不引入旧格式兼容代码。原有 AppShell 全局搜索测试再次复现“请求已调用但 DOM 尚未提交”的偶发失败；将异步等待包入 `act` 后，连续三次单项复测及整套测试均通过，没有修改搜索业务逻辑。

当前重构分支前端结果：58 个 Vitest 文件、372 项测试，17 项 Node 测试，lint/typecheck/build 全部通过。Rust Clippy、295 项核心测试、8 项 Tauri 测试及全部导入、导出、剪贴板和 v3 迁移集成测试均在合并提交前通过。重构功能任务仍保持 47/70，不把本次合并计为新增前端功能。
