## Context

Vistash 的 `v0.1.1` 已从合并后的 `main` 通过完整前端/Rust 门禁、Windows release 构建、隔离安装生命周期和真实桌面验收；当前 GitHub Release 仍是草稿，仓库根目录没有 README。项目所有者现在要把该版本对外开放，但仓库尚未配置 Authenticode 证书或签名服务凭据。

本变更只处理公开沟通与 Release 状态，不重新构建、不改 tag、不改运行时、不改库格式，也不引入 updater。公开对象定义为“未签名公开预览版”，不是已签名的正式稳定分发。

## Goals / Non-Goals

**Goals:**

- 用一份中文 README 让首次访问者快速理解 Vistash 解决什么问题、如何安装、数据存在哪里以及当前边界是什么。
- 把已验收的 `v0.1.1` 草稿 Release 转为公开预览，保留 NSIS、MSI 和 SHA-256 清单，并提供可核对的哈希与安装提示。
- 明确未签名 SmartScreen 风险、没有 updater、不会上传素材以及正式签名仍待后续的事实。
- 保持 `v0.1.0`、`v0.1.1` tag 不可变，公开 Release 与 README 均指向同一版本事实。

**Non-Goals:**

- 不生成或接入 Authenticode、Git signing 或 updater 私钥。
- 不修改 React、Rust、SQLite、Tauri command、安装器配置或库格式。
- 不把“图像反推提示词”描述成恢复历史原始提示词；当前版本只保留提示词管理与人工编辑能力。
- 不承诺 macOS/Linux、云同步、网页抓取、账号体系、自动更新或批量反推。

## Decisions

### 1. 公开版本定位为未签名预览

沿用已验证的 `v0.1.1` tag 和三个 Release 资产，只把草稿状态改为公开预览。Release 标题与正文明确“公开预览版（未签名）”和 SmartScreen 风险，不使用“稳定版”“已签名”或“官方认证”等误导性表述。正式签名发布另立变更，避免在没有凭据时临时改造流水线。

备选方案是继续保持草稿，安全性最高但无法满足当前对外试用目标；另一方案是临时自签名，自签名不能改善 Windows 信任链，反而容易制造错误安全感，均不采用。

### 2. README 作为新用户入口，不复制内部实现细节

README 按“产品一句话 → 适合谁 → 当前能力 → 安装 → 第一次使用 → 数据与隐私 → 明确边界 → 开发与验证 → 反馈”组织。功能描述只承诺已经存在并验收的图片库、提示词库、图片—提示词关联和 Windows 本地工作流；命令、路径和版本号使用可复制的代码块或链接。README 不嵌入个人测试截图、不暴露本地绝对路径、不复制大段 OpenSpec 内容。

备选方案是只放一个下载链接，无法解释本地数据语义和未签名风险；或把 README 写成 API/架构文档，会让首次用户无法快速上手，均拒绝。

### 3. 发布事实单一来源

README 链接到 GitHub Releases，版本安装说明和校验和以该 Release 的资产为准；`docs/releasing.md` 记录维护者流程和签名边界。发布正文只引用已经核验的 tag、资产名称、SHA-256 和安装提示，不重新上传本机候选，也不改变旧版本 Release。

### 4. 公开前后的可逆边界

公开前先保存当前草稿正文和资产清单；公开后只允许编辑说明文案，不移动 tag 或替换资产。若发现阻断问题，先把 Release 改回非公开并记录原因，再以更高 SemVer 发布修复。公开动作不删除用户数据、不删除 tag、不触发 updater。

## Risks / Trade-offs

- [Risk] 未签名安装器触发 SmartScreen 或被用户误认为可信软件 → README 与 Release 首屏重复提示“未签名公开预览”，并给出 SHA-256 核验方法。
- [Risk] README 与实际功能漂移 → 只写已完成验收的能力，发布前用当前主规格和 `v0.1.1` 资产复核链接与版本。
- [Risk] 公开 Release 被误改为旧草稿或替换资产 → 保留不可变 tag，只执行草稿到公开的状态转换，不调用删除/覆盖 tag 或资产的命令。
- [Risk] 用户将本地素材误解为会上传云端 → README 明确库复制、默认本地存储、无账号/无云同步，且不收集测试素材。

## Migration Plan

1. 在当前 `main` 创建公开发布 change 分支，完成 proposal、design、delta spec 和 tasks。
2. 编写 README 与发布手册补充，核对 `v0.1.1` tag、三个资产和 SHA-256。
3. 串行运行 OpenSpec strict、前端/Rust 现有门禁，并复核 README 中的命令与链接。
4. 用 GitHub API/CLI 把 `v0.1.1` 草稿转换为公开预览，确认 `isDraft=false`、资产仍为三个且正文含未签名警告。
5. 公开后复核 README、Release、tag 和 `main` 指向；如有阻断问题，先撤回 Release 可见性，修复通过新 PR 和新 patch 发布。

## Open Questions

- 当前无阻断问题。正式签名证书/云签名服务的选择留给后续正式分发变更，不阻止本次公开预览。
