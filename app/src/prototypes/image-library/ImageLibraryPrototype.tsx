/**
 * PROTOTYPE — 仅回答“Vistash 高级媒体工作室应该长什么样”。
 *
 * 三个结构不同的图片库方案通过 `?variant=A|B|C` 切换。固定假数据、不调用 IPC、
 * 不写真实素材库；评审完成后从主分支删除，禁止直接提升为生产实现。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import prototypeContactSheet from "./assets/prototype-contact-sheet.png";
import "./image-library-prototype.css";

type VariantKey = "A" | "B" | "C";
type ScreenKey = "workspace" | "welcome" | "empty" | "settings" | "light" | "multi" | "brand";

type Asset = {
  id: string;
  name: string;
  source: string;
  width: number;
  height: number;
  format: "JPG" | "PNG" | "WEBP";
  folder: string;
  tags: string[];
  note: string;
  favorite: boolean;
  seed: string;
  tone: string;
};

const ASSETS: Asset[] = [
  { id: "01", name: "朱红肖像研究", source: "DSC_1842.JPG", width: 3024, height: 4032, format: "JPG", folder: "人物 / 编辑肖像", tags: ["人物", "红光", "情绪"], note: "侧脸边缘的红色轮廓很适合作为叙事光线参考。", favorite: true, seed: "portrait-red-1842", tone: "#bd4d3f" },
  { id: "02", name: "混凝土回廊", source: "brutal_corridor_07.webp", width: 4096, height: 2731, format: "WEBP", folder: "建筑 / 粗野主义", tags: ["建筑", "灰阶", "透视"], note: "重复柱体和消失点。", favorite: false, seed: "concrete-arcade", tone: "#77766f" },
  { id: "03", name: "钴蓝器皿", source: "IMG_4421.PNG", width: 2800, height: 3500, format: "PNG", folder: "物件 / 材质", tags: ["蓝色", "陶瓷", "静物"], note: "高光克制，背景接近骨白。", favorite: true, seed: "cobalt-ceramic", tone: "#31579a" },
  { id: "04", name: "雾岭层次", source: "mountain_004.jpg", width: 5184, height: 2916, format: "JPG", folder: "场景 / 自然", tags: ["雾", "远景", "低对比"], note: "空气透视从深灰过渡到冷白。", favorite: false, seed: "mist-ridge", tone: "#798b88" },
  { id: "05", name: "虹彩玻璃体", source: "glass-object-final.png", width: 2400, height: 3000, format: "PNG", folder: "物件 / 材质", tags: ["透明", "虹彩", "棚拍"], note: "透明材质边缘带少量品红和青色分光。", favorite: true, seed: "iridescent-glass", tone: "#9b7a91" },
  { id: "06", name: "雨夜电车站", source: "night_station_11.jpg", width: 3840, height: 2160, format: "JPG", folder: "场景 / 城市", tags: ["夜景", "雨", "青橙"], note: "湿地反射让暗部仍有结构。", favorite: true, seed: "rainy-station", tone: "#265d68" },
  { id: "07", name: "纸构成 03", source: "paper-study-03.webp", width: 3000, height: 3000, format: "WEBP", folder: "抽象 / 造型", tags: ["纸张", "抽象", "骨白"], note: "硬折线与柔和投影的对照。", favorite: false, seed: "paper-sculpture", tone: "#c7bba8" },
  { id: "08", name: "沙丘余晖", source: "desert_roll_21.jpg", width: 4200, height: 2800, format: "JPG", folder: "场景 / 自然", tags: ["暖色", "沙漠", "电影感"], note: "地平线压低，保留大面积空域。", favorite: true, seed: "desert-cinema", tone: "#b77853" },
  { id: "09", name: "叶脉微距", source: "botanical_macro.png", width: 2400, height: 3600, format: "PNG", folder: "自然 / 微观", tags: ["植物", "纹理", "微距"], note: "半透明叶片适合研究背光。", favorite: false, seed: "botanical-macro", tone: "#59775b" },
  { id: "10", name: "单色立面", source: "facade_berlin_02.jpg", width: 3648, height: 2736, format: "JPG", folder: "建筑 / 立面", tags: ["建筑", "网格", "黑白"], note: "窗格尺度和负空间都很干净。", favorite: false, seed: "mono-facade", tone: "#6f706f" },
  { id: "11", name: "舞者拖影", source: "dance_scan_8.jpg", width: 2400, height: 3200, format: "JPG", folder: "人物 / 动态", tags: ["人物", "动态", "胶片"], note: "动作边缘的连续残影可以转成镜头语言。", favorite: true, seed: "dance-motion", tone: "#8a4744" },
  { id: "12", name: "银色织物", source: "textile_silver_01.webp", width: 3200, height: 2133, format: "WEBP", folder: "物件 / 材质", tags: ["金属", "织物", "冷光"], note: "柔软材质却有金属反射。", favorite: false, seed: "silver-textile", tone: "#909ba2" },
  { id: "13", name: "黄昏泳池", source: "pool_evening.jpg", width: 4096, height: 3072, format: "JPG", folder: "场景 / 建筑", tags: ["水面", "黄昏", "蓝色"], note: "蓝调时刻与室内暖光形成节奏。", favorite: true, seed: "evening-pool", tone: "#3d6680" },
  { id: "14", name: "赤陶静物", source: "stilllife_terracotta.png", width: 2600, height: 3400, format: "PNG", folder: "物件 / 静物", tags: ["赤陶", "静物", "暖色"], note: "哑光表面和低饱和红棕。", favorite: false, seed: "terracotta-stilllife", tone: "#a3533f" },
  { id: "15", name: "雾中车灯", source: "fog_lights_004.jpg", width: 5000, height: 2813, format: "JPG", folder: "场景 / 城市", tags: ["雾", "夜景", "电影感"], note: "点光源在雾中的扩散层级。", favorite: true, seed: "fog-car-lights", tone: "#756450" },
  { id: "16", name: "蓝图桌面", source: "studio_table_2.webp", width: 3600, height: 2400, format: "WEBP", folder: "工作室 / 过程", tags: ["桌面", "蓝图", "过程"], note: "纸张、金属和工具形成受控杂乱。", favorite: false, seed: "blueprint-table", tone: "#35536e" },
];
const FIRST_ASSET = ASSETS[0]!;
const MULTI_SELECTED_IDS = new Set(["01", "02", "05", "06", "11"]);

const VARIANTS: Array<{ key: VariantKey; name: string; note: string }> = [
  { key: "A", name: "Archive Desk", note: "三栏档案编辑台：清晰、紧凑、长期工作" },
  { key: "B", name: "Darkroom Strip", note: "图像暗房：最大画布、底部信息台" },
  { key: "C", name: "Curator Ledger", note: "策展账册：编辑感、浅色、高级档案馆" },
];

function imageUrl(asset: Asset, width = 900): string {
  return `https://picsum.photos/seed/${asset.seed}/${width}/${Math.round(width * asset.height / asset.width)}`;
}

export function ImageLibraryPrototype() {
  const [variant, setVariant] = useVariant();
  const [screen, setScreen] = usePrototypeScreen();
  const [selectedId, setSelectedId] = useState(FIRST_ASSET.id);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const selected = ASSETS.find((asset) => asset.id === selectedId)!;

  return (
    <div className="prototype-root">
      {screen === "welcome" && <VariantAWelcome />}
      {screen === "brand" && <VariantABrandBoard />}
      {screen !== "welcome" && screen !== "brand" && variant === "A" && (
        <VariantA
          selected={selected}
          onSelect={setSelectedId}
          onPreview={setLightboxId}
          onOpenSettings={() => setScreen("settings")}
          empty={screen === "empty"}
          light={screen === "light"}
          multi={screen === "multi"}
        />
      )}
      {screen === "workspace" && variant === "B" && (
        <VariantB
          selected={selected}
          onSelect={setSelectedId}
          onPreview={setLightboxId}
        />
      )}
      {screen === "workspace" && variant === "C" && (
        <VariantC
          selected={selected}
          onSelect={setSelectedId}
          onPreview={setLightboxId}
        />
      )}

      {lightboxId !== null && (
        <PrototypeLightbox
          asset={ASSETS.find((asset) => asset.id === lightboxId)!}
          onMove={(direction) => {
            const index = ASSETS.findIndex((asset) => asset.id === lightboxId);
            const next = (index + direction + ASSETS.length) % ASSETS.length;
            const nextAsset = ASSETS[next]!;
            setLightboxId(nextAsset.id);
            setSelectedId(nextAsset.id);
          }}
          onClose={() => setLightboxId(null)}
        />
      )}

      {screen === "settings" && <VariantASettings onClose={() => setScreen("workspace")} />}
      {screen === "workspace" && <PrototypeSwitcher variant={variant} onChange={setVariant} />}
      <PrototypeStateSwitcher screen={screen} onChange={(next) => {
        if (next !== "workspace") setVariant("A");
        setScreen(next);
      }} />
    </div>
  );
}

function usePrototypeScreen(): [ScreenKey, (screen: ScreenKey) => void] {
  const initial = new URLSearchParams(window.location.search).get("screen");
  const [screen, setScreenState] = useState<ScreenKey>(
    initial === "welcome" || initial === "empty" || initial === "settings" || initial === "light" || initial === "multi" || initial === "brand"
      ? initial
      : "workspace",
  );
  const setScreen = useCallback((next: ScreenKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set("prototype", "image-library");
    url.searchParams.set("screen", next);
    window.history.replaceState(null, "", url);
    setScreenState(next);
  }, []);
  return [screen, setScreen];
}

function useVariant(): [VariantKey, (variant: VariantKey) => void] {
  const initial = new URLSearchParams(window.location.search).get("variant");
  const [variant, setVariantState] = useState<VariantKey>(
    initial === "B" || initial === "C" ? initial : "A",
  );

  const setVariant = useCallback((next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set("prototype", "image-library");
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
    setVariantState(next);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = VARIANTS.findIndex((item) => item.key === variant);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length]!;
      setVariant(next.key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setVariant, variant]);

  return [variant, setVariant];
}

function VariantA({
  selected,
  onSelect,
  onPreview,
  onOpenSettings,
  empty = false,
  light = false,
  multi = false,
}: {
  selected: Asset;
  onSelect: (id: string) => void;
  onPreview: (id: string) => void;
  onOpenSettings: () => void;
  empty?: boolean;
  light?: boolean;
  multi?: boolean;
}) {
  const [view, setView] = useState<"masonry" | "list">("masonry");
  const [query, setQuery] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const visible = useMemo(
    () => empty ? [] : ASSETS.filter((asset) => `${asset.name}${asset.source}${asset.tags.join("")}`.toLowerCase().includes(query.toLowerCase())),
    [empty, query],
  );

  return (
    <div className={`proto-window variant-a ${light ? "a-light" : ""}`}>
      <div className="native-titlebar">
        <span className="native-app-name">Vistash</span>
        <div className="window-controls" aria-hidden="true"><span>—</span><span>□</span><span>×</span></div>
      </div>
      <header className="a-topbar">
        <BrandMark />
        <nav className="a-sections" aria-label="一级入口">
          <button className="is-active">图片</button>
          <button>提示词</button>
        </nav>
        <button className="a-global-search"><Icon name="search" /><span>在全部素材中查找</span><kbd>Ctrl K</kbd></button>
        <div className="topbar-spacer" />
        <button className="a-import"><Icon name="plus" /> 导入</button>
        <button className="icon-button task-button" onClick={() => setTaskOpen((value) => !value)} aria-label="任务中心"><Icon name="progress" /><i /></button>
        <button className="icon-button" aria-label="设置" onClick={onOpenSettings}><Icon name="settings" /></button>
      </header>

      <div className="a-workspace">
        <aside className="a-rail">
          <p className="rail-label">LIBRARY</p>
          <nav>
            <RailItem icon="grid" label="全部图片" count={empty ? "0" : "2,486"} active />
            <RailItem icon="star" label="收藏" count={empty ? "0" : "184"} />
            <RailItem icon="inbox" label="未分类" count={empty ? "0" : "37"} />
          </nav>
          <div className="rail-section-heading"><span>文件夹</span><button aria-label="新建文件夹">＋</button></div>
          {empty ? <p className="empty-rail-note">还没有文件夹</p> : <nav className="folder-tree">
            <RailItem icon="chevron" label="人物" count="328" />
            <RailItem icon="chevron" label="场景" count="617" />
            <div className="folder-child"><RailItem icon="dot" label="城市" count="205" /></div>
            <div className="folder-child"><RailItem icon="dot" label="自然" count="412" /></div>
            <RailItem icon="chevron" label="物件" count="446" />
            <RailItem icon="chevron" label="建筑" count="291" />
            <RailItem icon="chevron" label="抽象" count="173" />
          </nav>}
          <button className="rail-trash"><Icon name="trash" /><span>回收站</span><em>{empty ? "0" : "12"}</em></button>
          <div className="library-foot"><span className="status-dot" />视觉档案库<br /><small>D:\Vistash Library</small></div>
        </aside>

        <main className="a-main">
          <header className="collection-head">
            <div><p className="eyebrow">VISUAL ARCHIVE</p><h1>全部图片</h1></div>
            <div className="collection-summary"><strong>{empty ? "0" : "2,486"}</strong><span>张素材</span></div>
          </header>
          <div className="a-toolbar">
            <label className="local-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、来源或标签" /><kbd>Ctrl F</kbd></label>
            <button className="tool-button" disabled={empty}><Icon name="filter" /> 筛选 <span className="filter-count">{empty ? "0" : "2"}</span></button>
            <button className="tool-button">最近导入 <Icon name="chevronDown" /></button>
            <div className="toolbar-spacer" />
            <label className="density-control"><span>密度</span><input type="range" min="1" max="3" defaultValue="2" /></label>
            <div className="segmented"><button className={view === "masonry" ? "is-on" : ""} onClick={() => setView("masonry")} aria-label="瀑布流"><Icon name="grid" /></button><button className={view === "list" ? "is-on" : ""} onClick={() => setView("list")} aria-label="详情列表"><Icon name="list" /></button></div>
          </div>
          {!empty && <div className="filter-chips"><button>标签：电影感 <span>×</span></button><button>收藏 <span>×</span></button><button className="clear-chip">清除全部</button></div>}
          {empty ? (
            <div className="a-empty-state">
              <div className="empty-glyph"><BrandMark compact /></div>
              <p className="eyebrow">EMPTY VISUAL ARCHIVE</p>
              <h2>让第一批视觉素材进入档案库</h2>
              <p>拖入图片或文件夹，按 <kbd>Ctrl V</kbd> 粘贴，也可以从本机选择。源文件始终保持不变。</p>
              <div><button className="a-import"><Icon name="plus" /> 导入图片</button><button className="empty-folder-button"><Icon name="folder" /> 导入文件夹</button></div>
              <small>支持 PNG、JPG、WEBP、GIF 与 BMP</small>
            </div>
          ) : view === "masonry" ? (
            <div className="a-masonry">
              {visible.map((asset) => <MasonryCard key={asset.id} asset={asset} selected={multi ? MULTI_SELECTED_IDS.has(asset.id) : selected.id === asset.id} onSelect={onSelect} onPreview={onPreview} />)}
            </div>
          ) : (
            <DetailTable assets={visible} selected={selected} onSelect={onSelect} onPreview={onPreview} />
          )}
        </main>

        <aside className="a-inspector">
          {empty ? <InspectorEmpty /> : multi ? <BatchInspector /> : <Inspector asset={selected} />}
        </aside>
      </div>

      {taskOpen && <TaskPopover onClose={() => setTaskOpen(false)} />}
      {!empty && !multi && <div className="a-running-task"><span className="task-spinner" /><div><strong>正在导入「灵感参考」</strong><small>342 / 1,000 · mist-ridge.jpg</small></div><div className="mini-progress"><i style={{ width: "34.2%" }} /></div><button>停止</button></div>}
      {multi && <SelectionBar />}
    </div>
  );
}

function VariantAWelcome() {
  return (
    <div className="proto-window variant-a a-welcome">
      <div className="native-titlebar"><span className="native-app-name">Vistash</span><div className="window-controls"><span>—</span><span>□</span><span>×</span></div></div>
      <div className="welcome-layout">
        <main className="welcome-copy">
          <BrandMark />
          <p className="welcome-kicker">LOCAL VISUAL ARCHIVE</p>
          <h1>建立属于你的<br /><em>视觉档案库。</em></h1>
          <p className="welcome-lede">把散落在磁盘里的图像，整理成安静、可检索、完全由你掌控的创作资料室。</p>
          <div className="welcome-actions"><button className="a-import"><Icon name="plus" /> 创建新库</button><button><Icon name="folder" /> 打开已有库</button></div>
          <ul><li><Icon name="check" />素材复制进你选择的本地目录</li><li><Icon name="check" />不修改、不移动任何源文件</li><li><Icon name="check" />开放元数据，索引可以完整重建</li></ul>
          <p className="welcome-storage">选择库位置前不会创建任何文件。素材库可能增长到数十 GB，请选择空间充足的磁盘。</p>
        </main>
        <aside className="welcome-visual">
          <img src={prototypeContactSheet} alt="多种视觉素材组成的档案墙" />
          <div className="welcome-visual-overlay"><span>01—12</span><strong>YOUR MATERIAL,<br />UNDER YOUR CONTROL.</strong><small>VISTASH / LOCAL FIRST</small></div>
        </aside>
      </div>
    </div>
  );
}

function InspectorEmpty() {
  return <div className="inspector-empty"><div><Icon name="expand" /></div><h2>选择一张图片</h2><p>图片信息、色卡、文件夹、标签和备注会出现在这里。</p><kbd>Enter</kbd><span>打开沉浸预览</span></div>;
}

function BatchInspector() {
  return <div className="batch-inspector"><header><p className="eyebrow">MULTIPLE SELECTION</p><h2>已选择 5 张图片</h2><p>来自 4 个文件夹 · 3 张已收藏</p></header><section><small>文件夹</small><button className="mixed-field"><Icon name="folder" /><span>混合值</span><Icon name="chevronRight" /></button><button className="batch-primary"><Icon name="folder" />移动到文件夹</button></section><section><small>共同标签</small><div className="tag-list"><span>电影感<button>×</button></span><button className="add-tag">＋ 添加标签</button></div><p className="mixed-note">另有 7 个非共同标签</p></section><section><small>收藏</small><div className="batch-choice"><button>全部收藏</button><button>取消收藏</button></div></section><section><small>关联</small><button className="mixed-field"><Icon name="tag" /><span>关联到已有提示词</span><Icon name="chevronRight" /></button></section><section className="batch-danger"><button><Icon name="trash" />移入回收站</button><p>删除后仍可逐项还原，提示词关联不会丢失。</p></section></div>;
}

function SelectionBar() {
  return <div className="selection-bar"><strong>5</strong><span>张图片已选择</span><i /><button><Icon name="folder" />移动</button><button><Icon name="tag" />标签</button><button><Icon name="star" />收藏</button><button><Icon name="progress" />关联</button><button className="selection-danger"><Icon name="trash" />回收站</button><button className="selection-clear">清除选择</button></div>;
}

function VariantASettings({ onClose }: { onClose: () => void }) {
  return <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="设置"><div className="settings-dialog"><header><div><p className="eyebrow">VISTASH PREFERENCES</p><h2>设置</h2></div><button onClick={onClose}><Icon name="close" /></button></header><div className="settings-body"><nav><button className="active"><Icon name="settings" />外观</button><button><Icon name="folder" />素材库</button><button><Icon name="progress" />快捷键</button><button><Icon name="inbox" />关于</button></nav><main><section><h3>外观</h3><p>让界面适应你的工作环境，图片始终保持原始呈现。</p><label>主题</label><div className="theme-options"><button className="active"><i className="theme-system" /><strong>跟随系统</strong><small>随 Windows 自动切换</small></button><button><i className="theme-dark" /><strong>深色</strong><small>石墨暗房工作台</small></button><button><i className="theme-light" /><strong>浅色</strong><small>温和的档案纸面</small></button></div></section><section className="settings-row"><div><h3>减少动态效果</h3><p>跟随 Windows 辅助功能设置，关闭非必要位移和缩放。</p></div><button className="toggle is-on"><i /></button></section><section className="settings-row"><div><h3>界面语言</h3><p>当前版本使用简体中文。</p></div><span>简体中文</span></section></main></div><footer><span>设置会立即保存到本机</span><button onClick={onClose}>完成</button></footer></div></div>;
}

function VariantABrandBoard() {
  const palette = [
    { name: "Archive Black", value: "#111313" },
    { name: "Graphite", value: "#171919" },
    { name: "Bone", value: "#ebe7dd" },
    { name: "Signal Coral", value: "#e8664a" },
    { name: "Status Green", value: "#6e9b73" },
  ];
  return <div className="proto-window variant-a brand-board"><div className="native-titlebar"><span>Vistash — 品牌基础</span><div className="window-controls"><span>—</span><span>□</span><span>×</span></div></div><header className="brand-board-head"><div><p className="eyebrow">IDENTITY SYSTEM / 01</p><h1>视觉档案，不是图片占位符。</h1><p>“叠放档案框＋负形 V”把 vista 的观看与 stash 的收藏压缩进一个小尺寸仍可识别的符号。</p></div><BrandMark /></header><main className="brand-board-grid"><section className="brand-mark-panel"><div className="brand-app-icon"><VistaGlyph /></div><div className="brand-wordmark"><VistaGlyph /><strong>Vistash</strong><small>LOCAL VISUAL ARCHIVE</small></div><p>主图标以石墨为底、骨白框体、珊瑚 V 为唯一品牌色。禁止加入山峰、太阳、镜头光圈或渐变发光。</p></section><section className="brand-sizes"><p className="board-label">APP ICON / SMALL SIZE</p><div><span className="icon-64"><VistaGlyph /></span><span className="icon-32"><VistaGlyph /></span><span className="icon-16"><VistaGlyph /></span></div><p>16 px 时只保留两层框体和实心 V；不使用细线内部装饰。</p></section><section className="brand-colors"><p className="board-label">COLOR SYSTEM</p><div>{palette.map((color) => <article key={color.name}><i style={{ background: color.value }} /><strong>{color.name}</strong><code>{color.value}</code></article>)}</div></section><section className="brand-type"><p className="board-label">TYPE SYSTEM</p><div className="type-display"><span>DISPLAY / EDITORIAL SERIF</span><strong>建立属于你的<br /><em>视觉档案库。</em></strong><small>Georgia + SimSun / 品牌标题与欢迎场景</small></div><div className="type-ui"><span>INTERFACE / WINDOWS UI</span><strong>全部图片　2,486 张素材</strong><p>朱红肖像研究 · 3024 × 4032 · 2026-08-25</p><small>Bahnschrift + Microsoft YaHei UI / 控件、数据与用户内容</small></div></section><section className="brand-icons"><p className="board-label">ICON SYSTEM / PHOSPHOR</p><div>{["search", "folder", "tag", "star", "progress", "settings"].map((name) => <span key={name}><Icon name={name} /></span>)}</div><p>默认 regular weight，激活收藏使用 fill；单个界面不混用其他图标家族。</p></section><section className="brand-voice"><p className="board-label">VOICE</p><blockquote>安静地保存，清晰地找到。<br /><em>Your material, under your control.</em></blockquote><p>文案直接说明本地、复制入库、可恢复与失败原因，不使用“AI 魔法”“无限灵感”等营销套话。</p></section></main></div>;
}

function VariantB({ selected, onSelect, onPreview }: { selected: Asset; onSelect: (id: string) => void; onPreview: (id: string) => void }) {
  const [trayOpen, setTrayOpen] = useState(true);
  return (
    <div className="proto-window variant-b">
      <div className="native-titlebar b-native"><span>VISTASH — 暗房联系表</span><div className="window-controls"><span>—</span><span>□</span><span>×</span></div></div>
      <aside className="b-dock">
        <BrandMark compact />
        <button className="active"><Icon name="grid" /><small>素材</small></button>
        <button><Icon name="star" /><small>收藏</small></button>
        <button><Icon name="folder" /><small>文件夹</small></button>
        <span className="dock-spacer" />
        <button><Icon name="search" /><small>查找</small></button>
        <button><Icon name="settings" /><small>设置</small></button>
      </aside>
      <main className="b-stage">
        <header className="b-header">
          <div><p>ARCHIVE / ALL IMAGES</p><h1>暗房联系表</h1></div>
          <div className="b-stats"><span><b>2,486</b> 张素材</span><span><b>184</b> 已收藏</span><span><b>37</b> 未分类</span></div>
          <button className="b-add"><Icon name="plus" /> 导入</button>
        </header>
        <div className="b-command-line">
          <span className="command-prefix">⌘</span><input placeholder="筛选当前联系表…" />
          <button>最近 ↓</button><button>标签 02</button><button>尺寸 ◐</button>
        </div>
        <div className="b-contact-sheet">
          <img className="b-generated-sheet" src={prototypeContactSheet} alt="十二张视觉参考组成的联系表" />
          <div className="b-frame-grid">
          {ASSETS.slice(0, 12).map((asset, index) => (
            <button
              key={asset.id}
              className={`b-frame ${selected.id === asset.id ? "selected" : ""}`}
              onClick={() => onSelect(asset.id)}
              onDoubleClick={() => onPreview(asset.id)}
            >
              <span className="frame-index">{String(index + 1).padStart(3, "0")}</span>
              {asset.favorite && <span className="frame-mark">●</span>}
            </button>
          ))}
          </div>
        </div>
      </main>
      <aside className={`b-tray ${trayOpen ? "open" : ""}`}>
        <button className="tray-handle" onClick={() => setTrayOpen((value) => !value)}><span>当前选片</span><Icon name={trayOpen ? "chevronDown" : "chevronUp"} /></button>
        <div className="tray-content">
          <img src={imageUrl(selected, 420)} alt="" />
          <div className="tray-title"><small>素材 {selected.id}</small><h2>{selected.name}</h2><p>{selected.source} · {selected.width}×{selected.height}</p></div>
          <div className="tray-palette">{[selected.tone, "#d2c5b4", "#17191a", "#67767a"].map((color) => <i key={color} style={{ background: color }} />)}</div>
          <div className="tray-meta"><label>文件夹</label><strong>{selected.folder}</strong><label>标签</label><strong>{selected.tags.join(" · ")}</strong></div>
          <div className="tray-actions"><button><Icon name="folder" /> 移动</button><button><Icon name="tag" /> 标签</button><button onClick={() => onPreview(selected.id)}><Icon name="expand" /> 预览</button></div>
        </div>
      </aside>
      <div className="b-task-ribbon"><span>导入 34%</span><i><b style={{ width: "34%" }} /></i><em>剩余 658 项</em></div>
    </div>
  );
}

function VariantC({ selected, onSelect, onPreview }: { selected: Asset; onSelect: (id: string) => void; onPreview: (id: string) => void }) {
  const [indexOpen, setIndexOpen] = useState(true);
  return (
    <div className="proto-window variant-c">
      <div className="native-titlebar c-native"><span>Vistash</span><div className="window-controls"><span>—</span><span>□</span><span>×</span></div></div>
      <header className="c-header">
        <div className="c-wordmark"><BrandMark compact /><span>Vistash</span><em>视觉档案</em></div>
        <nav><button className="active">图片</button><button>提示词</button></nav>
        <button className="c-find"><Icon name="search" /> 全局查找 <kbd>⌘K</kbd></button>
        <button className="c-import">导入素材 <span>＋</span></button>
        <button className="c-round"><Icon name="progress" /></button>
        <button className="c-round"><Icon name="settings" /></button>
      </header>
      <div className="c-body">
        <aside className={`c-index ${indexOpen ? "" : "collapsed"}`}>
          <button className="index-toggle" onClick={() => setIndexOpen((value) => !value)}><span>目录</span><Icon name="chevronLeft" /></button>
          <div className="index-group"><small>图片库</small><button className="active"><span>全部素材</span><em>2,486</em></button><button><span>收藏</span><em>184</em></button><button><span>未分类</span><em>37</em></button></div>
          <div className="index-group"><small>文件夹</small>{["人物研究", "空间语言", "物件与表面", "自然系统", "工作过程"].map((item, index) => <button key={item}><span>{item}</span><em>{[328, 908, 446, 412, 173][index]}</em></button>)}</div>
          <div className="index-foot"><button>最近导入</button><button>回收站 <em>12</em></button></div>
        </aside>
        <main className="c-gallery">
          <header className="c-gallery-head"><div><p>COLLECTION 001</p><h1>完整视觉档案</h1><span>2,486 张图片，按最近导入排序。</span></div><div className="c-gallery-tools"><button>筛选 <i>2</i></button><button>最近 ↓</button><button><Icon name="grid" /></button><button><Icon name="list" /></button></div></header>
          <div className="c-active-filters"><span>电影感 <button>×</button></span><span>收藏 <button>×</button></span><button>清除</button></div>
          <div className="c-editorial-grid">
            {ASSETS.slice(0, 12).map((asset, index) => (
              <article key={asset.id} className={`${selected.id === asset.id ? "selected" : ""} card-${index % 6}`} onClick={() => onSelect(asset.id)} onDoubleClick={() => onPreview(asset.id)}>
                <div className="editorial-image"><img src={imageUrl(asset, 920)} alt={asset.name} />{asset.favorite && <span>✦</span>}</div>
                <div className="editorial-caption"><b>{asset.name}</b><small>{asset.format} · {asset.width}×{asset.height}</small><em>{String(index + 1).padStart(2, "0")}</em></div>
              </article>
            ))}
          </div>
        </main>
        <aside className="c-ledger">
          <header><small>当前素材</small><button>•••</button></header>
          <div className="ledger-preview"><img src={imageUrl(selected, 600)} alt={selected.name} /><button onClick={() => onPreview(selected.id)}><Icon name="expand" /></button></div>
          <h2>{selected.name}</h2><p className="ledger-source">来源 / {selected.source}</p>
          <section><small>文件</small><dl><div><dt>尺寸</dt><dd>{selected.width} × {selected.height}</dd></div><div><dt>格式</dt><dd>{selected.format}</dd></div><div><dt>导入时间</dt><dd>2026-08-25</dd></div></dl></section>
          <section><small>色卡</small><div className="ledger-palette">{[selected.tone, "#d9c9b5", "#171717", "#899391"].map((color) => <i key={color} style={{ background: color }} />)}</div></section>
          <section><small>组织</small><button className="ledger-folder"><Icon name="folder" />{selected.folder}<span>›</span></button><div className="ledger-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}<button>＋</button></div></section>
          <section><small>备注</small><p className="ledger-note">{selected.note}</p><span className="saved-state">刚刚保存</span></section>
        </aside>
      </div>
      <div className="c-import-note"><span>342</span><p>共 1,000 项素材正在导入</p><i><b style={{ width: "34.2%" }} /></i><button>停止</button></div>
    </div>
  );
}

function PrototypeSwitcher({ variant, onChange }: { variant: VariantKey; onChange: (variant: VariantKey) => void }) {
  const index = VARIANTS.findIndex((item) => item.key === variant);
  const move = (delta: number) => onChange(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length]!.key);
  const current = VARIANTS[index]!;
  return (
    <div className="prototype-switcher" role="group" aria-label="原型方案切换">
      <button onClick={() => move(-1)} aria-label="上一个方案">←</button>
      <div><strong>{current.key} — {current.name}</strong><span>{current.note}</span></div>
      <button onClick={() => move(1)} aria-label="下一个方案">→</button>
    </div>
  );
}

function PrototypeStateSwitcher({ screen, onChange }: { screen: ScreenKey; onChange: (screen: ScreenKey) => void }) {
  const options: Array<{ key: ScreenKey; label: string }> = [
    { key: "workspace", label: "工作区" },
    { key: "welcome", label: "欢迎" },
    { key: "empty", label: "空库" },
    { key: "settings", label: "设置" },
    { key: "light", label: "浅色" },
    { key: "multi", label: "多选" },
    { key: "brand", label: "品牌" },
  ];
  return <div className="prototype-state-switcher" role="group" aria-label="原型状态切换">{options.map((option) => <button key={option.key} className={screen === option.key ? "active" : ""} onClick={() => onChange(option.key)}>{option.label}</button>)}</div>;
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <div className={`brand-mark ${compact ? "compact" : ""}`} aria-label="Vistash"><VistaGlyph />{!compact && <span>Vistash</span>}</div>;
}

function VistaGlyph() {
  return <svg className="vista-glyph" viewBox="0 0 32 32" aria-hidden="true"><path className="glyph-back" d="M8 4h20v20" /><path className="glyph-frame" d="M4 8h20v20H4z" /><path className="glyph-v" d="m8.5 13 7.5 11.5L23.5 13h-4.2L16 19l-3.3-6z" /></svg>;
}

function RailItem({ icon, label, count, active = false }: { icon: string; label: string; count?: string; active?: boolean }) {
  return <button className={active ? "active" : ""}><Icon name={icon} /><span>{label}</span>{count && <em>{count}</em>}</button>;
}

function MasonryCard({ asset, selected, onSelect, onPreview }: { asset: Asset; selected: boolean; onSelect: (id: string) => void; onPreview: (id: string) => void }) {
  return (
    <button className={`masonry-card ${selected ? "selected" : ""}`} onClick={() => onSelect(asset.id)} onDoubleClick={() => onPreview(asset.id)}>
      <span className="card-image" style={{ aspectRatio: `${asset.width}/${asset.height}`, background: asset.tone }}><img src={imageUrl(asset)} alt={asset.name} loading="lazy" />{asset.favorite && <i className="favorite-mark"><Icon name="starFilled" /></i>}<span className="card-overlay"><b>{asset.name}</b><small>{asset.width} × {asset.height}</small></span></span>
    </button>
  );
}

function DetailTable({ assets, selected, onSelect, onPreview }: { assets: Asset[]; selected: Asset; onSelect: (id: string) => void; onPreview: (id: string) => void }) {
  return <div className="detail-table"><div className="detail-head"><span>名称</span><span>文件夹</span><span>标签</span><span>尺寸</span><span>格式</span></div>{assets.map((asset) => <button key={asset.id} className={selected.id === asset.id ? "selected" : ""} onClick={() => onSelect(asset.id)} onDoubleClick={() => onPreview(asset.id)}><span className="detail-name"><img src={imageUrl(asset, 160)} alt="" /><b>{asset.name}</b></span><span>{asset.folder}</span><span>{asset.tags.join(" · ")}</span><span>{asset.width}×{asset.height}</span><span>{asset.format}</span></button>)}</div>;
}

function Inspector({ asset }: { asset: Asset }) {
  return <><div className="inspector-preview"><img src={imageUrl(asset, 640)} alt={asset.name} /><button><Icon name="starFilled" /></button></div><div className="inspector-title"><div><h2>{asset.name}</h2><p>{asset.source}</p></div><button>•••</button></div><InspectorSection label="信息与色彩" open><div className="meta-grid"><span>尺寸</span><b>{asset.width} × {asset.height}</b><span>格式</span><b>{asset.format}</b><span>导入</span><b>2026-08-25 14:30</b></div><div className="palette">{[asset.tone, "#d7c7b4", "#17191a", "#718084", "#a78e72"].map((color) => <button key={color} style={{ background: color }} aria-label={color} />)}</div></InspectorSection><InspectorSection label="组织" open><label className="field-label">文件夹</label><button className="folder-field"><Icon name="folder" /><span>{asset.folder}</span><Icon name="chevronRight" /></button><label className="field-label">标签</label><div className="tag-list">{asset.tags.map((tag) => <span key={tag}>{tag}<button>×</button></span>)}<button className="add-tag">＋ 添加</button></div></InspectorSection><InspectorSection label="备注" open><textarea defaultValue={asset.note} /><p className="save-state"><span /> 已保存</p></InspectorSection><InspectorSection label="关联提示词"><p className="collapsed-summary">2 条普通关联</p></InspectorSection><InspectorSection label="文件信息"><p className="collapsed-summary">来源路径、哈希与媒体类型</p></InspectorSection></>;
}

function InspectorSection({ label, open = false, children }: { label: string; open?: boolean; children: React.ReactNode }) {
  return <section className={`inspector-section ${open ? "open" : ""}`}><button className="section-toggle"><span>{label}</span><Icon name={open ? "chevronDown" : "chevronRight"} /></button>{open && <div className="section-content">{children}</div>}</section>;
}

function TaskPopover({ onClose }: { onClose: () => void }) {
  return <aside className="task-popover"><header><div><p className="eyebrow">TASK CENTER</p><h2>后台任务</h2></div><button onClick={onClose}>×</button></header><article><div className="task-icon"><Icon name="download" /></div><div><strong>正在导入「灵感参考」</strong><p>342 / 1,000 · mist-ridge.jpg</p><div className="task-progress"><i style={{ width: "34.2%" }} /></div><small>约 3 分钟剩余</small></div><button>停止</button></article><article className="done"><div className="task-icon"><Icon name="check" /></div><div><strong>导出完成</strong><p>24 张原图已导出</p></div><button>查看</button></article></aside>;
}

function PrototypeLightbox({ asset, onMove, onClose }: { asset: Asset; onMove: (direction: -1 | 1) => void; onClose: () => void }) {
  const [zoom, setZoom] = useState(72);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onMove(-1);
      if (event.key === "ArrowRight") onMove(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onMove]);
  return <div className="prototype-lightbox"><header><button onClick={onClose}><Icon name="close" /></button><div><strong>{asset.name}</strong><span>{ASSETS.findIndex((item) => item.id === asset.id) + 1} / {ASSETS.length}</span></div><div className="lightbox-tools"><button onClick={() => setZoom(72)}>适合窗口</button><button onClick={() => setZoom(100)}>100%</button><button onClick={() => setZoom((value) => Math.max(25, value - 10))}>−</button><span>{zoom}%</span><button onClick={() => setZoom((value) => Math.min(180, value + 10))}>＋</button></div></header><button className="lightbox-nav prev" onClick={() => onMove(-1)}>←</button><div className="lightbox-canvas"><img src={imageUrl(asset, 1600)} alt={asset.name} style={{ width: `${zoom}%` }} /></div><button className="lightbox-nav next" onClick={() => onMove(1)}>→</button></div>;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
    progress: <><path d="M12 3a9 9 0 1 1-8 4.9" /><path d="M3 3v5h5" /></>,
    grid: <><rect x="4" y="4" width="6" height="7" /><rect x="14" y="4" width="6" height="4" /><rect x="4" y="15" width="6" height="5" /><rect x="14" y="12" width="6" height="8" /></>,
    list: <><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4" cy="6" r=".7" fill="currentColor" /><circle cx="4" cy="12" r=".7" fill="currentColor" /><circle cx="4" cy="18" r=".7" fill="currentColor" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z" />,
    starFilled: <path fill="currentColor" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z" />,
    inbox: <><path d="M4 5h16v14H4z" /><path d="M4 14h5l1.5 2h3L15 14h5" /></>,
    trash: <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
    chevronLeft: <path d="m15 6-6 6 6 6" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    chevronUp: <path d="m6 15 6-6 6 6" />,
    dot: <circle cx="12" cy="12" r="2" fill="currentColor" />,
    filter: <path d="M4 6h16M7 12h10M10 18h4" />,
    folder: <path d="M3.5 6.5h6l2 2H21v10H3.5z" />,
    tag: <path d="M4 5h7l9 9-6 6-10-10z" />,
    expand: <><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></>,
    download: <><path d="M12 4v11M8 11l4 4 4-4M5 20h14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] ?? paths.dot}</svg>;
}
