# 多选与文件夹组织验收（8.5、9.1）

日期：2026-08-28。承接此前未提交的 UI 基础、8.2–8.4 和 8.5 开发中代码；本轮修复当前门禁并完成 8.5、9.1，当前任务进度为 58/75。没有提交、推送或切换默认应用入口。

## 静态门禁修复

- 原有 6 条 lint 错误来自测试中的不安全数组断言与原地排序；改为独立的成员/长度断言，不做隐式类型转换，也不为 ES2022 引入新的数组 API。
- 原有 2 条类型错误分别是虚拟化 Key 与组件 key 参数类型不一致，以及可空活动 ID 被传给写操作；直接使用素材哈希作为 React key，并对实际传入的活动 ID 收窄。
- 回收站不渲染菜单时同样保留素材 key，避免分支漏掉列表身份。

## 8.5 多选与反馈

- 单击、Ctrl 增减、Shift 范围、Ctrl+A、Esc、方向键及 Home/End 共用同一选择模型，瀑布流与列表保持同一选择集合。
- 活动项始终属于选择集合；清空后活动项为 null，独立 focusedId 保留键盘位置。
- 输入框和弹层拥有自己的快捷键；素材卡片上的 Ctrl+A 正常全选，搜索中的 Escape 不再清除图片选择。
- Ctrl 框选使用按下时的选择快照，缩回矩形不会累积旧命中；Esc、pointercancel 和失去捕获均可收束。命中使用虚拟布局，不按可见 DOM 决定选择。
- 素材动作在触发时冻结目标。收藏、回收站、移动共用模块内部写入与报告逻辑，部分成功显示每个失败项的显示名和错误码；清空选择后报告仍保留，只有明确关闭才移除。
- 新查询仍使用旧占位数据时禁止发起组织写入；同一库写操作串行，当前操作期间相关按钮不可重复提交。

真实浏览器曾复现“右键菜单点击没有执行”的问题：Portal 事件沿 React 树冒泡，框选误认菜单点击为画布空白拖动。增加真实 DOM 归属检查后，菜单恢复正常，原浏览器用例转绿；没有改动 Radix 或增加兼容分支。

## 9.1 文件夹组织

- 新建子文件夹使用当前逻辑文件夹作为父级，成功后按后端返回路径导航。
- 重命名失败保留名称与原查询；成功后，当前查询若处于被重命名子树中，按返回路径更新前缀。
- 删除文件夹必须二次确认，明确告知子树范围和“不会删除图片”。失败不改现场；删除当前子树成功后转到未分类。
- 单张/多张均可通过移动 Dialog 明确选择目标或未分类；部分失败保留目标并只重试失败项。
- 内部拖动使用 Pointer Events 和指针捕获，拖动已选图片时移动整组选中项；取消不提交，拖到未分类传递 null 归属。不传磁盘路径，也不改 Tauri 外部文件拖放配置。
- 窄窗口提供按需导航 Dialog 和移动表单，不因侧栏收起而失去文件夹入口。名称编辑 Dialog 不被工作区 Ctrl+F 抢占。

## 回归证据

通过 `asset-library/index.ts` 公开 interface 验证，系统边界使用 Tauri IPC mock。现有测试保留，新增回归先观察失败再实现；图片模块目前共 36 项测试。

失败复现包括：取消选中后活动项越界、卡片 Ctrl+A 不生效、框选缩回残留命中、部分失败报告不存在、目录操作入口缺失、拖动没有写入、窄窗口导航缺失，以及编辑 Dialog 的 Ctrl+F 被错误认领。

浏览器在 Windows Edge 上执行以下脚本，均使用开发内存库及品牌测试图，不访问真实素材库：

```powershell
# 在 app/，先启动本仓库 Vite 开发服务。
python -X utf8 scripts/selection-check.py --base-url http://127.0.0.1:4190
python -X utf8 scripts/folder-organization-check.py --base-url http://127.0.0.1:4190
python -X utf8 scripts/asset-session-check.py --base-url http://127.0.0.1:4190
```

三套流程均覆盖深色/浅色与 1440×900/760×600，共 12 组通过；没有页面运行时错误。宽窗口实际执行鼠标拖动与取消，窄窗口执行等价的移动 Dialog。另验证非法名称保留、重命名子树、删除确认/取消及图片保留。

报告和截图分别位于 `app/artifacts/asset-selection/`、`app/artifacts/folder-organization/`、`app/artifacts/asset-session/`。文件夹 Dialog 截图在动画完成态采集，已检查窄窗口标签、输入、焦点和操作区可见。

## 工程门禁与范围审查

- `pnpm lint`、`pnpm typecheck`：通过。
- `pnpm test`：59 个测试文件、410 项 Vitest 与 17 项 Node 测试通过。
- `pnpm build`：通过；仍有既存的 Tauri window API 静态/动态导入提示，未改动该导入。
- `cargo clippy --workspace --all-targets -- -D warnings` 与 `cargo test --workspace --quiet`：全部通过，包含 8 项 Tauri、295 项 core 和 74 项集成契约测试。
- OpenSpec 严格校验、`git diff --check` 与 UTF-8 无 BOM 检查：通过。

按 `web-design-guidelines` 当日[上游规则](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)核对本轮新增表单、菜单、拖动等价操作和局部反馈：真实 label、原生控件、焦点环、错误码、确认层、深浅主题 select 颜色及无水平溢出均已核对。必需目标未选择时禁用提交遵循本项目已批准的安全约束。

此记录不是第 11 节的最终全局审查：图像反推仍暂停；9.2 之后的文件名编辑、完整检查器、灯箱、全局任务中心接线、10,000 项完整性能与 release Tauri 原生交互验收仍按任务清单推进。新模块继续只在开发入口独立验收，生产入口在 11.3 达到整体等价后一次切换。
