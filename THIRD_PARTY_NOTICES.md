# 第三方依赖与资产归属

本文记录 Vistash 当前版本的直接发布依赖、开发依赖许可证和自有展示资产。它不替代各依赖包随附的完整许可证文本；分发二进制时应同时保留依赖包要求的版权和许可证通知。

审计日期：2026-09-01。来源：`pnpm licenses list --prod --json`、`cargo metadata --format-version 1`、`app/package.json`、Cargo manifests 和 `app/src-tauri/icons/`。

## 发布运行时依赖

以下依赖会参与 Vistash 的运行时或发布构建；表中的 SPDX 标识是包管理器声明的许可证。`MIT OR Apache-2.0` 表示使用者可以按其中任一许可证履行义务。

### JavaScript/TypeScript

| 依赖 | SPDX | 上游 |
| --- | --- | --- |
| React、React DOM、Radix UI、TanStack Query/Virtual、Phosphor Icons | `MIT` | 各包的 npm 元数据与上游仓库 |
| `@tauri-apps/api` | `Apache-2.0 OR MIT` | [Tauri](https://github.com/tauri-apps/tauri) |
| `@tauri-apps/plugin-dialog` | `MIT OR Apache-2.0` | [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) |
| `tslib` | `0BSD` | [TypeScript](https://github.com/microsoft/tslib) |

### Rust

| 依赖 | SPDX | 上游 |
| --- | --- | --- |
| `tauri`、`tauri-plugin-dialog`、`tauri-plugin-clipboard-manager`、`tauri-plugin-opener` | `Apache-2.0 OR MIT` | [Tauri](https://github.com/tauri-apps/tauri) 与 [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) |
| `image`、`webp`、`serde`、`serde_json`、`thiserror`、`chrono`、`uuid`、`sha2`、`hex`、`windows`、`tempfile` | `MIT OR Apache-2.0`（个别包为 `MIT`） | 各 crate 的 crates.io 元数据与上游仓库 |
| `rusqlite` | `MIT` | [rusqlite](https://github.com/rusqlite/rusqlite) |

## 开发依赖中的其他许可证

完整开发树包含 `MPL-2.0`、`BlueOak-1.0.0`、`BSD-2-Clause`、`BSD-3-Clause`、`ISC`、`CC0-1.0`、`0BSD` 等声明。它们来自测试、构建、lint 或开发工具的传递依赖，不被 Vistash 的 MIT 许可证覆盖；更新依赖或改变打包方式时必须重新执行审计。

```powershell
# 在 app/ 目录查看生产依赖
pnpm licenses list --prod --long

# 在 app/ 目录查看 Rust workspace 依赖及其 license 字段
cargo metadata --format-version 1
```

## Vistash 自有资产

- `app/src-tauri/icons/` 与 `docs/assets/vistash-icon-256.png`：Vistash 项目标识资产，按根目录 `LICENSE` 的自有资产范围发布。
- `app/src/assets/welcome/`：项目维护者提供并确认有权发布的匿名欢迎页展示图片，按根目录 `LICENSE` 的自有资产范围发布。
- `docs/assets/screenshots/`：使用匿名 fixture 生成的产品界面截图，不包含个人素材或用户库。
- 应用使用 Windows 系统字体栈，不重新分发 Microsoft 字体文件。

如果未来加入第三方字体、图片、音频、品牌标识或带 NOTICE 的依赖，必须在本文件记录来源、版本、许可证和分发位置；只有存在具体通知义务时才新增根 `NOTICE`。
