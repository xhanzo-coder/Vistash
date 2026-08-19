## 1. 工程初始化

- [x] 1.1 按设计第十条建立 `app/` 布局：`app/Cargo.toml` 为 workspace 根，成员为 `crates/vistash-core` 与 `src-tauri`，React 与 TypeScript 前端置于 `app/src/`，确认开发模式可启动窗口
- [x] 1.2 落地三条真实命令：前端 lint、TypeScript 类型检查、`cargo clippy` 与 `cargo test`；在 `AGENTS.md` 记录命令原文、两个工作目录的分工（OpenSpec 命令在仓库根，`pnpm` 与 `cargo` 在 `app/`）以及构建前置条件（Rust 工具链与 MSVC 生成工具）
- [x] 1.3 按设计第一条拆分两个 crate：`vistash-core` 承载 `library`、`hashing`、`sidecar`、`media`、`colorcard`、`import`、`index`，其 `Cargo.toml` 依赖表中不得出现 `tauri`；`commands` 薄层留在 `src-tauri`
- [x] 1.4 确认新增文本文件均为无 BOM 的 UTF-8，并把生成物目录写入忽略规则

## 2. 库骨架与寻址

- [x] 2.1 实现 `hashing`：SHA-256 计算与两级 fanout 路径推导
- [x] 2.2 编写哈希与寻址测试：已知内容映射到已知摘要与已知路径，覆盖 fanout 切片位置
- [x] 2.3 实现 `library`：创建库骨架（库级元数据、文件夹树文件、`objects/`、`trash/`、`prompts/`），写入格式版本与哈希算法标识
- [x] 2.4 实现格式版本校验：高于程序支持的版本必须拒绝打开；库级元数据缺失或无法解析必须报告损坏并拒绝，不得自愈重建
- [x] 2.5 实现 `sidecar`：素材侧车的序列化与反序列化，字段与 `asset-library` 已生效需求一致
- [x] 2.6 实现库位置的显式选择与记忆：首次运行必须要求选择，重启直接打开，记录路径不可用时报告并回到选择，已有库必须打开而非重建，非空的非库目录必须拒绝

## 3. 媒体处理与色卡

- [x] 3.1 实现 `media` 的解码：支持 PNG、JPEG、WebP、GIF 首帧、BMP，清单外的文件按 `import.unsupported_media_type` 拒绝
- [x] 3.2 实现 `media` 的降采样与缩略图编码：固定长边 512、写死重采样滤波器、保持宽高比、不放大小于目标的素材、输出 WebP 至独立的 `thumbnails/` 目录树
- [x] 3.3 实现 `colorcard`：OKLab 转换与按亮度分位点的确定性初始化聚类，内部用 `f64`，写死迭代次数、收敛阈值、小簇过滤与邻近合并阈值
- [x] 3.4 实现色卡结果契约：`algo_version`、`status`、`failure_reason`、`sampled_pixel_count`、固定枚举的 `role`、按有效像素归一的 `share`、`hex` 与 `oklab` 并存、最多 8 条且超限报 `color_card.cluster_failed`
- [x] 3.5 编写色卡确定性测试：同一素材连续计算多次结果逐字段相同
- [x] 3.6 实现三个 `color_card.*` 失败码，并验证失败时 `colors` 为空数组而非静默返回

## 4. 导入管线与索引

- [x] 4.1 实现 `import` 的主路径：计算摘要、复制本体、写入侧车，写入顺序固定为先本体后侧车
- [x] 4.2 实现两级去重：命中 `objects/` 报 `import.duplicate_in_library`，命中 `trash/` 报 `import.duplicate_in_trash`
- [x] 4.3 实现九个 `import.*` 错误码与单素材回滚：批量导入中单个素材失败不得影响已完成的素材
- [x] 4.4 编写导入回滚不变量测试：在复制成功后、侧车写入前注入失败，断言库中不存在无侧车的本体，也不存在无本体的侧车
- [x] 4.5 实现 `index`：SQLite 表结构、`user_version` 标记，以及版本不匹配时删除索引并全量重扫重建
- [x] 4.6 编写索引重建等价性测试：导入若干素材后取索引快照，删除索引文件重建，比对快照相等（已接受的不可重建字段除外）

## 5. IPC 与界面

- [x] 5.1 实现 `commands` 薄层：只做参数转换与错误码映射，不含业务判断
- [x] 5.2 在 `src/shared` 集中封装 IPC 调用与错误码到中文文案的映射，组件内不得直接调用 IPC
- [x] 5.3 实现导航骨架：素材与提示词库并列为一级入口，未实现的入口必须显式呈现为尚未实现，不得渲染为空列表
- [x] 5.4 实现选库界面：首次运行的选择流程与打开已有库的流程
- [x] 5.5 实现拖入文件与文件夹的导入入口，以及带错误码的逐项失败呈现
- [x] 5.6 实现缩略图网格：只消费后端产出的缩略图，缺失时按需重新生成，生成失败必须显式呈现原因而非留空
- [ ] 5.7 实现单图预览：呈现原图、色卡与 HEX 复制
- [x] 5.8 验证界面层不读取像素：前端不得使用 `Canvas`、`OffscreenCanvas` 或 `ImageData` 做缩放、采样或聚类

## 6. 验证与收尾

- [x] 6.1 运行全部测试与 lint、类型检查，确认三条命令均通过
- [ ] 6.2 用真实素材走通完整链路：选库、导入、网格、预览、色卡、HEX 复制
- [ ] 6.3 记录导入 100 张素材的耗时基线并写入 `design.md`，作为后续是否并行化的实测依据
- [x] 6.4 实测缩略图长边 512 与 WebP 质量参数，把结论写回 `design.md` 的待确定问题
- [x] 6.5 执行 `code-review`，核对仓库规范与 OpenSpec 符合性
- [ ] 6.6 运行 `openspec validate implement-vistash-import-and-browse --strict --no-interactive` 并修正全部问题
