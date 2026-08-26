# Windows 平台集成调研：剪贴板、系统打开与临时副本

## 调研范围

本文为 OpenSpec change `redesign-image-library-workspace` 核实以下 Windows 平台事实：

1. 从 Windows 资源管理器复制文件或文件夹后，如何读取 `CF_HDROP`；
2. 如何读取位图剪贴板，同时遵守“前端不得处理像素”的工程约束；
3. Tauri 2 官方 `clipboard-manager`、`dialog`、`opener` 插件的能力与权限边界；
4. 如何使用默认关联程序打开图片，以及为何不能把库内对象直接交给外部程序；
5. 只读临时副本在 Windows 文件占用模型下的生命周期与安全清理边界；
6. 推荐的 Rust、Tauri 与 Win32 API 路径。

调研时间：2026-08-25。资料优先采用 Microsoft Learn、Tauri 官方文档与官方源码；文中将“事实”“推断”“推荐”明确分开。

## 结论摘要

- **事实：** `CF_HDROP` 是传递现有文件系统对象位置的预定义 Shell 剪贴板格式，负载是指向 `DROPFILES` 的全局内存对象；`DragQueryFileW` 可以先取条目数、再逐项取完整路径。[Microsoft：Shell Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard) [Microsoft：DragQueryFileW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragqueryfilew)
- **事实：** Tauri 2 官方 `clipboard-manager` 只公开文本、HTML、图片和清空剪贴板的命令，没有读取 `CF_HDROP` 文件列表的命令；读取资源管理器文件列表需要 Windows 专用 Rust 适配器。[Tauri Clipboard 文档](https://v2.tauri.app/plugin/clipboard/) [Tauri clipboard-manager invoke 源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/src/lib.rs)
- **推荐：** 粘贴导入由一个 Rust command 完成仲裁：先读 `CF_HDROP`，有文件列表时复用路径导入；否则再读位图。位图在 Rust 侧取得 RGBA、编码为 PNG 并进入既有导入管线，前端只接收任务进度和结果，不接收像素。
- **事实：** Tauri `opener.openPath` 能用默认程序打开文件，但它只负责启动/委托，不提供“只读打开”语义。[Tauri Opener 文档](https://v2.tauri.app/plugin/opener/)
- **推荐：** 永远不要把内容哈希对象路径直接传给外部程序。应复制到 Vistash 专属缓存目录，设置只读属性后再打开；隔离副本才是保护库对象的安全边界，只读属性只是附加提示。
- **事实：** Windows 删除仍被其他进程占用的文件可能失败；普通 Shell 打开也不保证能取得可等待的进程句柄。因此不能在 `openPath` 返回后立即删除临时副本。[Microsoft：DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew) [Microsoft：SHELLEXECUTEINFO](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)

## 1. 资源管理器文件与文件夹剪贴板

### 1.1 `CF_HDROP` 的数据语义

**事实：** Microsoft 将 `CF_HDROP` 列在“传输文件系统对象”的 Shell 格式中。它用于传递一组已经存在的对象位置，是预定义格式，不需要调用 `RegisterClipboardFormat`。数据媒介中的 `hGlobal` 指向 `DROPFILES`；`DROPFILES.pFiles` 是双 NUL 终止的文件名序列偏移，每个条目是包含终止 NUL 的完全限定路径。[Microsoft：Shell Clipboard Formats / CF_HDROP](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard)

**事实：** `DragQueryFileW` 的读取协议为：

- `iFile == 0xFFFFFFFF` 时返回条目总数；
- `iFile` 是有效索引且输出缓冲区为 `NULL` 时，返回该路径所需字符数，不包含终止 NUL；
- 提供缓冲区后返回实际复制的字符数，同样不包含终止 NUL。[Microsoft：DragQueryFileW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragqueryfilew)

**推断：** `CF_HDROP` 条目本身只是路径，不携带“按 Vistash 文件导入”或“按目录递归导入”的产品语义。Rust 侧必须在复制出自有 `PathBuf` 后查询文件系统元数据，再按文件或目录进入现有导入管线。条目从剪贴板取出后，源文件仍可能被用户移动、删除或改名，所以实际导入时仍必须逐项报告 `not_found`、权限失败等稳定错误。

**推断：** `CF_HDROP` 只覆盖具有真实文件系统路径的对象。Outlook 附件或部分 Shell 虚拟对象可能通过 `CFSTR_FILEDESCRIPTOR` 与 `CFSTR_FILECONTENTS` 传输，而不是给出可由 `DragQueryFileW` 枚举的路径；Microsoft 将这两组格式分别列为文件系统对象与虚拟对象传输机制。[Microsoft：Shell Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard)

**推荐：** 第一阶段明确只支持 `CF_HDROP`。虚拟文件粘贴需要 OLE `IDataObject`、描述符与流式内容提取，应作为独立 OpenSpec 变更，不得把“剪贴板里有附件但没有路径”静默当成普通文件导入。

### 1.2 正确的读取顺序

**事实：** `IsClipboardFormatAvailable` 用于判断指定标准或已注册格式是否可用；`OpenClipboard` 成功后会阻止其他程序修改剪贴板，若另一个窗口已经打开剪贴板则会失败；每次成功的 `OpenClipboard` 都必须配对 `CloseClipboard`。[Microsoft：IsClipboardFormatAvailable](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-isclipboardformatavailable) [Microsoft：OpenClipboard](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard) [Microsoft：CloseClipboard](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-closeclipboard)

**事实：** `GetClipboardData` 返回的句柄由剪贴板控制。调用者必须立即复制需要的数据，不得释放句柄，不得在 `CloseClipboard` 之后继续使用该句柄；Microsoft 还明确要求把剪贴板内容视为不可信数据并谨慎解析。[Microsoft：GetClipboardData](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboarddata)

**推荐读取算法：**

1. 在单一 Rust worker 上串行化剪贴板操作；
2. 调用 `IsClipboardFormatAvailable(CF_HDROP)`；
3. `OpenClipboard(hwnd)`，失败时返回明确的 `clipboard_busy`，不静默当成空剪贴板；
4. `GetClipboardData(CF_HDROP)`，把返回值转换为 `HDROP`；
5. 用 `DragQueryFileW(..., 0xFFFFFFFF, ...)` 读取数量；
6. 每项先查询长度，再分配 `Vec<u16>`，读取并立即转换成自有 `OsString`/`PathBuf`；
7. 通过 RAII guard 保证所有成功打开路径都调用 `CloseClipboard`；
8. 关闭剪贴板后才执行目录遍历、图片解码和库写入，避免长时间独占系统剪贴板。

**推荐：** 只使用 `W` 版 Unicode API，不使用 `DragQueryFileA`，避免 Windows 路径经过 ANSI 代码页发生信息损失。

**推荐：** 即使剪贴板同时存在 `CFSTR_PREFERREDDROPEFFECT`，Vistash 也只读取路径并执行“复制进库”。它不得因为资源管理器的剪切/移动意图而删除或移动源文件。

## 2. Windows 位图剪贴板

### 2.1 适合支持的格式

**事实：** Windows 标准位图剪贴板格式包括：

- `CF_BITMAP`：`HBITMAP`，设备相关位图；
- `CF_DIB`：`BITMAPINFO` 后跟位图字节的内存对象；
- `CF_DIBV5`：`BITMAPV5HEADER`、颜色空间信息和位图字节的内存对象。[Microsoft：Standard Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)

**事实：** Windows 能在 `CF_BITMAP`、`CF_DIB`、`CF_DIBV5` 之间执行系统合成转换。Microsoft 建议复制位图时优先提供 `CF_DIB` 或 `CF_DIBV5`，因为它们是设备无关格式；`CF_DIBV5` 还可携带颜色空间信息。[Microsoft：Clipboard Formats / Synthesized Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)

**推荐：** Vistash 第一阶段把以下内容定义为“位图型剪贴板”：

1. 优先 `CF_DIBV5`；
2. 其次 `CF_DIB`；
3. 最后 `CF_BITMAP`，允许 Windows 或依赖库完成到设备无关像素的转换。

**推断：** 浏览器、截图工具和图像编辑器可能同时放入标准格式与自定义/已注册格式。第一阶段不应承诺读取任意注册的 `PNG`、`JFIF`、GIF、SVG 或 HTML 图片格式；只要能通过上述标准位图链获得解码像素，即视为支持。后续若互操作测试发现透明通道或色彩空间损失，再为具体已注册格式建立独立规格与解析器。

### 2.2 Tauri 官方图片读取的实际形状

**事实：** Tauri 官方 `clipboard-manager` 在桌面端使用 `arboard`。其 Rust `read_image()` 调用 `arboard::Clipboard::get_image()`，得到解码后的像素、宽度和高度，再创建 Tauri `Image`；JavaScript `readImage()` 返回 Tauri 图片资源。[Tauri clipboard-manager desktop 源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/src/desktop.rs) [Tauri clipboard-manager guest JS 源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/guest-js/index.ts)

**事实：** `arboard::get_image()` 返回解码像素，并明确说明外部应用放入的图片不保证一定是受支持格式；Windows 剪贴板是全局对象，并发操作很容易产生 `ClipboardOccupied` 或死锁，因此不建议多线程并行操作。[arboard Clipboard 官方 API 文档](https://docs.rs/arboard/latest/arboard/struct.Clipboard.html)

**推荐：** 不调用 JavaScript `readImage().rgba()`，也不把 RGBA 经 IPC 传给 React。应在自有 Rust command 中调用 `app.clipboard().read_image()`，随后在 Rust 侧完成：

1. 检查宽高、`width * height * 4` 溢出和允许的最大像素数；
2. 将 RGBA 编码成 PNG；
3. 生成“剪贴板图片 YYYY-MM-DD HHMMSS.png”显示名；
4. 把 PNG 字节直接交给现有内容哈希、侧车、缩略图和索引管线；
5. 只向前端返回 `ImportOutcome` 与进度。

这条路径遵守项目规定：前端不通过 Canvas、OffscreenCanvas 或 JavaScript 字节循环执行像素处理。

**推荐：** `CF_HDROP` 优先于位图。当资源管理器复制图片文件时，剪贴板可能同时提供可显示位图；若先读位图，可能把一个原始 JPEG 错误地重新编码成 PNG，并丢失原始格式和来源信息。

## 3. Tauri 2 官方插件能力与权限

### 3.1 `clipboard-manager`

**事实：** Tauri 2 `clipboard-manager` 支持 Windows，提供 Rust 与 JavaScript API。官方命令仅包括 `read_text`、`write_text`、`read_image`、`write_image`、`write_html` 和 `clear`。[Tauri Clipboard 文档](https://v2.tauri.app/plugin/clipboard/) [Tauri invoke handler 源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/src/lib.rs)

**事实：** 插件默认不授予任何剪贴板能力；WebView 调用必须显式启用 `clipboard-manager:allow-read-image`、`clipboard-manager:allow-write-image`、`clipboard-manager:allow-read-text` 等具体权限。[Tauri Clipboard 权限表](https://v2.tauri.app/plugin/clipboard/#default-permission)

**事实：** 官方命令与权限表均不存在“读取文件列表”或 `CF_HDROP` 能力。因此 `clipboard-manager` 不能单独实现资源管理器文件/文件夹粘贴。

**推荐：** 图片粘贴也从自有 Rust command 进入，不给 WebView 开放通用 `clipboard-manager:allow-read-image`。插件可以只作为受信任 Rust 侧的图片剪贴板实现依赖；前端只获得 Vistash 特定的 `paste_import` command 权限。这能缩小 WebView 直接读取系统剪贴板的能力面。

### 3.2 `dialog`

**事实：** Tauri `dialog` 提供原生打开、保存和消息对话框。`open` 的 `multiple` 控制多选，`directory` 控制文件夹选择；Windows、Linux 和 macOS 返回文件系统路径。[Tauri Dialog 文档](https://v2.tauri.app/plugin/dialog/)

**事实：** `dialog` 默认权限集合包含 `allow-message`、`allow-save` 与 `allow-open`；也可只授予 `dialog:allow-open` 或 `dialog:allow-save`。[Tauri Dialog 权限表](https://v2.tauri.app/plugin/dialog/#default-permission)

**事实：** Tauri 官方 JavaScript API 源码说明，`open()` 与 `save()` 选中的路径会临时加入 filesystem/asset protocol scope，并建议安全优先的应用使用专用 command。[Tauri dialog guest JS 源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/dialog/guest-js/index.ts)

**推断：** `dialog` 是用户主动选择文件或目录的入口，不是系统剪贴板读取器；它不能替代 `CF_HDROP` 适配器。

**推荐：**

- 导入图片与导入文件夹继续使用 `dialog:allow-open`；
- 多文件导出选择目标目录也可使用 `open({ directory: true })`；
- 只有单文件“另存为”需要 `dialog:allow-save`；
- 维持 `capabilities/default.json` 的最小授权，不因为一个操作启用整个 `dialog:default`。

### 3.3 `opener`

**事实：** Tauri `opener` 能用指定程序或默认程序打开文件和 URL，也能在系统文件管理器中显示文件；`openPath(path)` 与 Rust `app.opener().open_path(path, None)` 都表示使用默认程序打开。[Tauri Opener 文档](https://v2.tauri.app/plugin/opener/)

**事实：** 从 WebView 调用时，潜在危险命令和作用域默认被阻止。`opener:allow-open-path` 需要通过 glob scope 限定允许的路径。[Tauri Opener 权限文档](https://v2.tauri.app/plugin/opener/#permissions)

**推荐：** 不向 JavaScript 开放能匹配整个素材库或任意磁盘路径的 `openPath` scope。由 Rust command 验证素材身份、创建临时副本，并通过 Rust `OpenerExt` 打开已经确认位于 Vistash 专属缓存根下的路径。前端只获得“按素材 ID 使用默认程序打开”的窄命令。

## 4. 默认关联程序打开图片与写回风险

### 4.1 系统打开语义

**事实：** Win32 `ShellExecuteW` 的 `open` verb 打开 `lpFile` 指定的文件或文件夹；`lpOperation == NULL` 时先使用默认 verb，不存在默认 verb 时再使用 `open`。[Microsoft：ShellExecuteW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew)

**事实：** Tauri `openPath(path)` 明确表示用默认程序打开文件，但接口没有只读参数，也没有承诺监控或阻止外部应用写文件。[Tauri Opener 使用说明](https://v2.tauri.app/plugin/opener/#usage)

**事实：** Windows 文件关联决定文件类型对应的处理程序与可用 verb；默认关联可能把同一图片类型交给仅查看程序，也可能交给具有编辑能力的程序。[Microsoft：How File Associations Work](https://learn.microsoft.com/en-us/windows/win32/shell/fa-how-work)

**推断：** 若把库内内容哈希对象路径直接传给默认程序，外部程序能否写入取决于文件 ACL、属性、打开共享模式和该程序行为；Tauri `opener` 本身不会保护文件。具有编辑能力的默认程序可能原地保存，从而让实际字节不再匹配路径中的内容哈希，破坏 Vistash 库不变量。

### 4.2 推荐的隔离模型

**推荐：** “使用默认程序打开”必须执行以下流程：

1. 根据素材 ID 在后端解析并校验权威对象路径；
2. 把对象复制到 `app_cache_dir()/external-open/v1/<session-id>/`；
3. 临时文件使用显示文件名和真实格式扩展名；同一素材重复打开可以复用同一不可变副本；
4. 复制完成并关闭 Vistash 自己的文件句柄；
5. 给副本设置 `FILE_ATTRIBUTE_READONLY`；
6. 仅把副本路径交给 `app.opener().open_path(..., None)`；
7. 外部修改、另存为或复制行为永不回写库对象。

**事实：** Windows `FILE_ATTRIBUTE_READONLY` 表示应用可以读取文件，但不能写入或删除文件。[Microsoft：SetFileAttributesW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileattributesw)

**推断：** 同一用户权限下的外部程序仍可能清除只读属性，或使用“另存为”产生其他文件。因此只读属性不是安全边界；真正保证内容哈希对象不被改写的是“只传临时副本，不传库对象路径”。

## 5. 临时副本、文件占用与清理边界

### 5.1 为什么不能立即删除

**事实：** Windows 文件打开的访问模式与共享模式必须兼容；没有 `FILE_SHARE_DELETE` 时，后续删除访问可能失败。`DeleteFileW` 在其他普通 I/O 或内存映射句柄仍打开且未允许 `FILE_SHARE_DELETE` 时失败，成功删除也要等到最后一个句柄关闭才真正完成。[Microsoft：CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) [Microsoft：DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew)

**事实：** 即使使用 `ShellExecuteExW` 和 `SEE_MASK_NOCLOSEPROCESS`，通过 DDE 或已有应用实例满足打开请求时也可能拿不到 `hProcess`；因此不能可靠地把“某个进程退出”当作所有默认关联程序都支持的文件生命周期信号。[Microsoft：SHELLEXECUTEINFO / SEE_MASK_NOCLOSEPROCESS](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)

**推断：** Tauri `openPath` 成功只表示系统接受了打开请求，不表示目标程序已经完成读取，更不表示目标程序已经关闭文件。因此 `await openPath(...)` 后立即删除副本存在竞态。

**推荐：** 不使用 `FILE_FLAG_DELETE_ON_CLOSE` 创建外部打开副本。该标志要求其他打开者也允许 `FILE_SHARE_DELETE`，而默认关联程序的共享模式不受 Vistash 控制；此外在把路径交给 Shell 前关闭唯一句柄会直接触发删除。[Microsoft：CreateFile / FILE_FLAG_DELETE_ON_CLOSE](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

### 5.2 可安全清理的精确范围

**事实：** Tauri `app.path().app_cache_dir()` 返回应用专属缓存目录，解析为系统缓存根加 bundle identifier；Windows 的系统缓存根位于用户的 `LocalAppData`。[Tauri `PathResolver::app_cache_dir`](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html#method.app_cache_dir)

**推荐目录：**

```text
<app_cache_dir>/
└─ external-open/
   └─ v1/
      ├─ <previous-session-id>/
      │  ├─ manifest.json
      │  └─ <asset display filename>
      └─ <current-session-id>/
         ├─ manifest.json
         └─ <asset display filename>
```

**推荐清理约束：**

- 只删除经过绝对规范化后仍位于 `<app_cache_dir>/external-open/v1/` 下的 Vistash 自建 session 目录；
- manifest 记录 Vistash 实际创建的相对文件名、素材哈希、创建时间和版本；不扫描、猜测或删除系统临时目录中的其他内容；
- 当前进程的 session 目录在正常运行期间不清理；只在下次启动时处理旧 session；
- 删除前先清除 Vistash 自己设置的只读属性，因为 `DeleteFileW` 删除只读文件会返回 `ERROR_ACCESS_DENIED`；[Microsoft：DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew)
- 对 `ERROR_SHARING_VIOLATION` 做特定恢复：保留该副本、记录明确清理结果，并在下次启动重试；其他错误不得被静默吞掉；
- 不沿 manifest 外的路径、绝对路径或 `..` 删除；目录 junction、符号链接或 reparse point 不得作为递归清理入口；
- 永远不清理库根、内容哈希目录、导入源路径或用户选择的导出目录。

**推荐：** 使用足够保守的过期策略，例如只清理“非当前 session 且创建已超过 24 小时”的目录。它不是 Windows 的事实，而是为无法可靠观察外部程序生命周期而选择的产品策略，应在 OpenSpec 设计中固定并测试。

## 6. 推荐实现路径

### 6.1 文件/文件夹粘贴

在 Tauri command 层增加 Windows 专用适配器，使用 `windows` crate 的官方 Win32 bindings：

```text
Win32::System::DataExchange
  OpenClipboard
  CloseClipboard
  GetClipboardData
  IsClipboardFormatAvailable

Win32::System::Ole
  CF_HDROP

Win32::UI::Shell
  DragQueryFileW
  HDROP
```

推荐封装成一个窄接口：

```rust
enum ClipboardImportSource {
    Paths(Vec<PathBuf>),
    Bitmap(ClipboardBitmap),
    Empty,
}

trait ClipboardImportSourceReader {
    fn read_for_import(&self) -> Result<ClipboardImportSource, AppError>;
}
```

生产环境使用 Windows adapter，测试使用内存 adapter。`Paths` 与 `Bitmap` 只是 Rust 内部接缝，不应成为前端 DTO；公开 command 应直接运行导入并返回任务结果。

Microsoft 维护的 `windows` crate 提供对应绑定：[OpenClipboard](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/DataExchange/fn.OpenClipboard.html)、[GetClipboardData](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/DataExchange/fn.GetClipboardData.html)、[DragQueryFileW](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/UI/Shell/fn.DragQueryFileW.html)。建议只启用实现所需 features：

```toml
windows = { version = "...", features = [
  "Win32_Foundation",
  "Win32_System_DataExchange",
  "Win32_System_Ole",
  "Win32_UI_Shell",
  "Win32_Storage_FileSystem",
] }
```

### 6.2 位图粘贴

首选路径：

1. 安装并初始化官方 `tauri-plugin-clipboard-manager`；
2. 只在 Rust command 的 blocking worker 内使用 `ClipboardExt::read_image()`；官方实现也警告桌面读取方法不应运行在主线程；[Tauri clipboard-manager desktop 源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/src/desktop.rs)
3. 把 Tauri `Image` 的 RGBA 交给 `vistash-core` 的 PNG 编码与导入用例；
4. 剪贴板读取与编码不在 Tauri 主线程并发执行；整个应用内由单一 coordinator 串行化剪贴板访问。

若针对 Photoshop、截图工具、浏览器的 Windows 互操作测试证明官方插件不能满足透明通道或色彩空间要求，再单独实现 `CF_DIBV5`/`CF_DIB` 解析；不得在没有失败证据时同时维护两套位图解析路径。

### 6.3 导入/导出对话框

- 继续使用官方 `tauri-plugin-dialog`；
- 文件导入：`open({ multiple: true, directory: false })`；
- 文件夹导入：`open({ multiple: true, directory: true })`；
- 批量导出目标：选择目录；
- 单文件另存为：`save()`；
- WebView capability 只授予实际调用的 `dialog:allow-open`、`dialog:allow-save`。

### 6.4 默认程序打开

首选官方 `tauri-plugin-opener` 的 Rust `OpenerExt`，但只接收后端刚创建并验证过的 Vistash 临时副本路径。无需直接调用 `ShellExecuteW`。

只有在未来产品明确要求“等待外部进程结束”且接受 `hProcess` 可能为空的语义时，才评估 `ShellExecuteExW`；当前 change 不应为不可靠的进程生命周期增加自定义 Win32 启动实现。

## 7. 对当前 OpenSpec 的直接约束

1. `Ctrl+V` 在非文本输入上下文触发一个统一的 Rust `paste_import` 用例；文件列表优先，位图次之，文本/网址不导入。
2. 资源管理器文件与文件夹粘贴是 Windows 专用能力；规格和错误码必须明确平台边界。
3. 位图像素不得进入 React/TypeScript；前端仅处理任务状态、导入结果与错误码。
4. Tauri 官方 `clipboard-manager` 不能替代 `CF_HDROP` adapter。
5. 使用默认程序打开时只能暴露只读临时副本，禁止暴露内容哈希对象路径。
6. 外部程序修改副本永不自动回写；本 change 不引入文件监控或外部编辑同步。
7. 临时副本清理是“旧 session、有清单、限定缓存根、占用时保留并重试”，不是 `openPath` 返回后立即删除。
8. `capabilities/default.json` 必须保持最小权限：对话框按需授权；不要把通用剪贴板读取和任意路径 opener 权限直接开放给 WebView。

## 8. 本机最小验证

2026-08-25 在当前 Windows 开发机运行 `app/scripts/prototype-windows-platform-check.ps1`，验证结果为通过。该 spike 没有读取或覆盖系统剪贴板，而是在进程内构造合法 `DROPFILES` 全局内存，再调用真实 `DragQueryFileW`：

- 两条包含中文的 Windows 路径按原顺序、逐字符完整往返；
- 设置只读属性后，普通删除按预期被 Windows 拒绝；
- 文件以不包含 `FILE_SHARE_DELETE` 的共享模式打开时，删除按预期失败；
- 2×2 带 alpha 位图能在本机编码出合法 PNG 签名字节；
- 测试只在经绝对路径校验的系统临时子目录操作，并在结束后清理该显式目录。

该验证只证明 Win32 内存形状、文件属性/共享模式和本机 PNG 编码假设可行，不替代后续真实资源管理器、截图工具、浏览器、Photoshop 和 Tauri release 构建互操作验收。
