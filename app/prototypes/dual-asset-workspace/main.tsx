// PROTOTYPE — 可丢弃双素材工作台。三个结构变体通过 ?variant=A|B|C 切换。
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  imageFixtures,
  imageFolderFixtures,
  promptFixtures,
  promptFolderFixtures,
  tagFixtures,
} from "./data";
import type { ImageFixture, LibraryKind, PromptFixture, ViewKind } from "./data";
import { TanStackVirtualCollection } from "./tanstack-virtual";
import { VirtualCollection } from "./virtual";
import "./prototype.css";

type Variant = "A" | "B" | "C";
type VirtualEngine = "owned" | "tanstack";
type InspectorTab = "info" | "organize" | "note" | "relations";
type SelectionState = {
  activeId: string | null;
  anchorId: string | null;
  selectedIds: Set<string>;
};
type WorkspacePreferences = {
  leftWidth: number;
  rightWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  views: Record<LibraryKind, ViewKind>;
};
type RelationDialog = { kind: LibraryKind; id: string } | null;

const PREF_KEY = "PROTOTYPE:dual-asset-workspace:v1";
const variants: Variant[] = ["A", "B", "C"];
const variantNames: Record<Variant, string> = {
  A: "平衡工作台",
  B: "内容优先",
  C: "编目台",
};
const imageById = new Map(imageFixtures.map((item) => [item.id, item]));
const promptById = new Map(promptFixtures.map((item) => [item.id, item]));

function initialVariant(): Variant {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "B" || value === "C" ? value : "A";
}

function initialVirtualEngine(): VirtualEngine {
  return new URLSearchParams(window.location.search).get("engine") === "tanstack" ? "tanstack" : "owned";
}

function initialPreferences(): WorkspacePreferences {
  const raw = window.localStorage.getItem(PREF_KEY);
  if (raw === null) {
    return {
      leftWidth: 236,
      rightWidth: 356,
      leftOpen: true,
      rightOpen: true,
      views: { images: "masonry", prompts: "masonry" },
    };
  }
  const parsed = JSON.parse(raw) as WorkspacePreferences;
  return parsed;
}

function emptySelection(): SelectionState {
  return { activeId: null, anchorId: null, selectedIds: new Set() };
}

function titleForPrompt(prompt: PromptFixture): string {
  return prompt.title ?? prompt.text.split(".")[0] ?? prompt.text;
}

function PrototypeApp() {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [virtualEngine, setVirtualEngine] = useState<VirtualEngine>(initialVirtualEngine);
  const [library, setLibrary] = useState<LibraryKind>("images");
  const [preferences, setPreferences] = useState<WorkspacePreferences>(initialPreferences);
  const [folders, setFolders] = useState<Record<LibraryKind, string>>({ images: "全部", prompts: "全部" });
  const [favoriteOnly, setFavoriteOnly] = useState<Record<LibraryKind, boolean>>({ images: false, prompts: false });
  const [queries, setQueries] = useState<Record<LibraryKind, string>>({ images: "", prompts: "" });
  const deferredQuery = useDeferredValue(queries[library]);
  const [selection, setSelection] = useState<Record<LibraryKind, SelectionState>>({
    images: emptySelection(),
    prompts: emptySelection(),
  });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("info");
  const [renderedCount, setRenderedCount] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [relationDialog, setRelationDialog] = useState<RelationDialog>(null);
  const [relationAdds, setRelationAdds] = useState<Set<string>>(() => new Set());
  const [relationRemoves, setRelationRemoves] = useState<Set<string>>(() => new Set());
  const [coverOverrides, setCoverOverrides] = useState<Map<string, string>>(() => new Map());
  const [toast, setToast] = useState<string | null>(null);
  const collectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    const collapseForNarrowWindow = () => {
      if (window.innerWidth <= 1080) {
        setPreferences((current) => current.leftOpen || current.rightOpen ? { ...current, leftOpen: false, rightOpen: false } : current);
      }
    };
    collapseForNarrowWindow();
    window.addEventListener("resize", collapseForNarrowWindow);
    return () => window.removeEventListener("resize", collapseForNarrowWindow);
  }, []);

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "k") {
        event.preventDefault();
        setGlobalSearchOpen(true);
      }
      if (key === "f") {
        const input = document.querySelector<HTMLInputElement>("[data-current-library-search]");
        if (input !== null) {
          event.preventDefault();
          input.focus();
        }
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, []);

  const filteredImages = useMemo(() => {
    const query = deferredQuery.trim().toLocaleLowerCase();
    return imageFixtures.filter((item) => (
      (folders.images === "全部" || item.folder === folders.images) &&
      (!favoriteOnly.images || item.favorite) &&
      (query.length === 0 || item.name.toLocaleLowerCase().includes(query) || item.tags.some((tag) => tag.includes(query)))
    ));
  }, [deferredQuery, favoriteOnly.images, folders.images]);

  const filteredPrompts = useMemo(() => {
    const query = deferredQuery.trim().toLocaleLowerCase();
    return promptFixtures.filter((item) => (
      (folders.prompts === "全部" || item.folder === folders.prompts) &&
      (!favoriteOnly.prompts || item.favorite) &&
      (query.length === 0 || titleForPrompt(item).toLocaleLowerCase().includes(query) || item.text.toLocaleLowerCase().includes(query) || item.tags.some((tag) => tag.includes(query)))
    ));
  }, [deferredQuery, favoriteOnly.prompts, folders.prompts]);

  const currentIds = useMemo(
    () => (library === "images" ? filteredImages.map((item) => item.id) : filteredPrompts.map((item) => item.id)),
    [filteredImages, filteredPrompts, library],
  );
  const currentSelection = selection[library];
  const currentView = preferences.views[library];
  const Collection = virtualEngine === "tanstack" ? TanStackVirtualCollection : VirtualCollection;

  function changeVariant(next: Variant) {
    setVariant(next);
    const params = new URLSearchParams(window.location.search);
    params.set("variant", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  function changeVirtualEngine(next: VirtualEngine) {
    setVirtualEngine(next);
    const params = new URLSearchParams(window.location.search);
    params.set("engine", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  function selectItem(id: string, modifiers: { ctrl: boolean; shift: boolean }) {
    setSelection((all) => {
      const current = all[library];
      let selectedIds: Set<string>;
      let anchorId = current.anchorId;
      if (modifiers.shift && anchorId !== null) {
        const start = currentIds.indexOf(anchorId);
        const end = currentIds.indexOf(id);
        const [from, to] = start <= end ? [start, end] : [end, start];
        selectedIds = new Set(currentIds.slice(Math.max(0, from), to + 1));
      } else if (modifiers.ctrl) {
        selectedIds = new Set(current.selectedIds);
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        anchorId = id;
      } else {
        selectedIds = new Set([id]);
        anchorId = id;
      }
      return { ...all, [library]: { activeId: id, anchorId, selectedIds } };
    });
  }

  function boxSelect(ids: string[]) {
    setSelection((all) => ({
      ...all,
      [library]: { activeId: ids[0] ?? null, anchorId: ids[0] ?? null, selectedIds: new Set(ids) },
    }));
  }

  function handleCollectionKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = selection[library];
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "a") {
      event.preventDefault();
      setSelection((all) => ({
        ...all,
        [library]: {
          activeId: current.activeId ?? currentIds[0] ?? null,
          anchorId: currentIds[0] ?? null,
          selectedIds: new Set(currentIds),
        },
      }));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSelection((all) => ({ ...all, [library]: emptySelection() }));
      return;
    }
    if (event.key === "Enter" && current.activeId !== null) {
      event.preventDefault();
      setFocusId(current.activeId);
      return;
    }
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const activeIndex = Math.max(0, currentIds.indexOf(current.activeId ?? ""));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? Math.max(0, currentIds.length - 1)
        : event.key === "ArrowDown" || event.key === "ArrowRight"
          ? Math.min(currentIds.length - 1, activeIndex + 1)
          : Math.max(0, activeIndex - 1);
    const nextId = currentIds[nextIndex];
    if (nextId !== undefined) selectItem(nextId, { ctrl: false, shift: event.shiftKey });
  }

  function beginResize(side: "left" | "right", event: React.PointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startWidth = side === "left" ? preferences.leftWidth : preferences.rightWidth;
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const width = side === "left" ? startWidth + delta : startWidth - delta;
      setPreferences((current) => ({
        ...current,
        [side === "left" ? "leftWidth" : "rightWidth"]: Math.max(side === "left" ? 176 : 280, Math.min(side === "left" ? 360 : 560, width)),
      }));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  function baseLinked(imageId: string, promptId: string): boolean {
    const prompt = promptById.get(promptId);
    return prompt?.linkedImageIds.includes(imageId) === true;
  }

  function isLinked(imageId: string, promptId: string): boolean {
    const key = `${imageId}::${promptId}`;
    if (relationRemoves.has(key)) return false;
    return relationAdds.has(key) || baseLinked(imageId, promptId);
  }

  function toggleRelation(imageId: string, promptId: string) {
    const key = `${imageId}::${promptId}`;
    if (isLinked(imageId, promptId)) {
      setRelationAdds((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setRelationRemoves((current) => new Set(current).add(key));
    } else {
      setRelationRemoves((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setRelationAdds((current) => new Set(current).add(key));
    }
  }

  function linkedImageIdsForPrompt(prompt: PromptFixture): string[] {
    const ids = new Set(prompt.linkedImageIds);
    for (const key of relationAdds) {
      const [imageId, promptId] = key.split("::");
      if (promptId === prompt.id && imageId !== undefined) ids.add(imageId);
    }
    for (const key of relationRemoves) {
      const [imageId, promptId] = key.split("::");
      if (promptId === prompt.id && imageId !== undefined) ids.delete(imageId);
    }
    return [...ids];
  }

  const topBar = (
    <header className="prototype-topbar">
      <div className="prototype-brand">
        <span className="brand-mark">V</span>
        <span>Vistash</span>
        <small>PROTOTYPE</small>
      </div>
      <nav aria-label="素材库切换" className="library-switcher">
        <button type="button" className={library === "images" ? "is-current" : ""} onClick={() => setLibrary("images")}>图片素材</button>
        <button type="button" className={library === "prompts" ? "is-current" : ""} onClick={() => setLibrary("prompts")}>提示词</button>
      </nav>
      <button type="button" className="global-search-trigger" onClick={() => setGlobalSearchOpen(true)}>
        <span>全局搜索</span><kbd>Ctrl K</kbd>
      </button>
      <div className="topbar-actions">
        <button type="button">导入</button>
        <button type="button" aria-label="设置">⚙</button>
      </div>
    </header>
  );

  const sidebar = (
    <Sidebar
      library={library}
      folder={folders[library]}
      favoriteOnly={favoriteOnly[library]}
      onFolder={(folder) => setFolders((current) => ({ ...current, [library]: folder }))}
      onFavorite={() => setFavoriteOnly((current) => ({ ...current, [library]: !current[library] }))}
      onCollapse={() => setPreferences((current) => ({ ...current, leftOpen: false }))}
    />
  );

  const center = (
    <section className="prototype-center" aria-label={library === "images" ? "图片素材集合" : "提示词集合"}>
      <CollectionToolbar
        library={library}
        view={currentView}
        query={queries[library]}
        resultCount={currentIds.length}
        selectedCount={currentSelection.selectedIds.size}
        onQuery={(query) => setQueries((current) => ({ ...current, [library]: query }))}
        onView={(view) => setPreferences((current) => ({ ...current, views: { ...current.views, [library]: view } }))}
        onClearSelection={() => setSelection((current) => ({ ...current, [library]: emptySelection() }))}
      />
      <div ref={collectionRef} className="collection-keyboard-surface" tabIndex={0} onKeyDown={handleCollectionKey}>
        {library === "images" ? (
          <Collection
            items={filteredImages}
            view={currentView}
            getId={(item) => item.id}
            estimateCardHeight={(item, width) => width * item.height / item.width + 66}
            renderCard={(item) => <ImageCard item={item} />}
            renderRow={(item) => <ImageRow item={item} />}
            activeId={currentSelection.activeId}
            selectedIds={currentSelection.selectedIds}
            onActivate={selectItem}
            onFocusItem={setFocusId}
            onBoxSelect={boxSelect}
            onRenderedCount={setRenderedCount}
          />
        ) : (
          <Collection
            items={filteredPrompts}
            view={currentView}
            getId={(item) => item.id}
            estimateCardHeight={(item, width) => linkedImageIdsForPrompt(item).length === 0 ? 206 : width * 0.72 + 132}
            renderCard={(item) => {
              const linkedImageIds = linkedImageIdsForPrompt(item);
              const requestedCover = coverOverrides.get(item.id) ?? item.coverImageId;
              const coverId = requestedCover !== null && linkedImageIds.includes(requestedCover) ? requestedCover : linkedImageIds[0] ?? null;
              return <PromptCard item={item} coverId={coverId} linkedImageCount={linkedImageIds.length} />;
            }}
            renderRow={(item) => <PromptRow item={item} />}
            activeId={currentSelection.activeId}
            selectedIds={currentSelection.selectedIds}
            onActivate={selectItem}
            onFocusItem={setFocusId}
            onBoxSelect={boxSelect}
            onRenderedCount={setRenderedCount}
          />
        )}
      </div>
    </section>
  );

  const inspector = (
    <Inspector
      library={library}
      activeId={currentSelection.activeId}
      selectedIds={currentSelection.selectedIds}
      tab={inspectorTab}
      setTab={setInspectorTab}
      isLinked={isLinked}
      onOpenRelations={(kind, id) => setRelationDialog({ kind, id })}
      coverOverrides={coverOverrides}
      setCoverOverrides={setCoverOverrides}
      getLinkedImages={(prompt) => linkedImageIdsForPrompt(prompt)}
      onLocalFiles={(promptId, count) => {
        setRelationAdds((current) => {
          const next = new Set(current);
          for (let index = 0; index < count; index += 1) next.add(`image-${9000 + index}::${promptId}`);
          return next;
        });
        setToast(`原型：${count} 张本地图片已“入库并关联”`);
        window.setTimeout(() => setToast(null), 2600);
      }}
      onCollapse={() => setPreferences((current) => ({ ...current, rightOpen: false }))}
    />
  );

  const layoutProps: LayoutProps = {
    topBar,
    sidebar,
    center,
    inspector,
    preferences,
    onOpenLeft: () => setPreferences((current) => ({ ...current, leftOpen: true })),
    onOpenRight: () => setPreferences((current) => ({ ...current, rightOpen: true })),
    onResizeLeft: (event) => beginResize("left", event),
    onResizeRight: (event) => beginResize("right", event),
  };

  return (
    <div className={`prototype-root variant-${variant.toLocaleLowerCase()}`}>
      {variant === "A" && <VariantA {...layoutProps} />}
      {variant === "B" && <VariantB {...layoutProps} />}
      {variant === "C" && <VariantC {...layoutProps} />}
      {focusId !== null && <FocusOverlay library={library} id={focusId} onClose={() => setFocusId(null)} />}
      {globalSearchOpen && (
        <GlobalSearch query={globalQuery} onQuery={setGlobalQuery} onClose={() => setGlobalSearchOpen(false)} onLocate={(kind, id) => {
          setLibrary(kind);
          setSelection((current) => ({ ...current, [kind]: { activeId: id, anchorId: id, selectedIds: new Set([id]) } }));
          setGlobalSearchOpen(false);
        }} />
      )}
      {relationDialog !== null && (
        <RelationPicker
          target={relationDialog}
          isLinked={isLinked}
          onToggle={toggleRelation}
          onClose={() => setRelationDialog(null)}
        />
      )}
      {toast !== null && <div role="status" className="prototype-toast">{toast}</div>}
      <PrototypeSwitcher
        variant={variant}
        onVariant={changeVariant}
        engine={virtualEngine}
        onEngine={changeVirtualEngine}
        state={`${library === "images" ? "图片" : "提示词"} · ${currentView === "masonry" ? "瀑布流" : "详情列表"} · 结果 ${currentIds.length.toLocaleString()} · DOM ${renderedCount} · 选中 ${currentSelection.selectedIds.size} · 活动 ${currentSelection.activeId ?? "无"}`}
      />
    </div>
  );
}

type LayoutProps = {
  topBar: ReactNode;
  sidebar: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
  preferences: WorkspacePreferences;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onResizeLeft: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeRight: (event: React.PointerEvent<HTMLDivElement>) => void;
};

export function VariantA(props: LayoutProps) {
  const columns = `${props.preferences.leftOpen ? props.preferences.leftWidth : 0}px 1fr ${props.preferences.rightOpen ? props.preferences.rightWidth : 0}px`;
  return (
    <div className="layout-a">
      {props.topBar}
      <div className="balanced-workspace" style={{ gridTemplateColumns: columns }}>
        {props.preferences.leftOpen ? <div className="panel-shell left-shell">{props.sidebar}<div className="resize-handle right-edge" onPointerDown={props.onResizeLeft} /></div> : <CollapsedTab label="分类" side="left" onClick={props.onOpenLeft} />}
        {props.center}
        {props.preferences.rightOpen ? <div className="panel-shell right-shell"><div className="resize-handle left-edge" onPointerDown={props.onResizeRight} />{props.inspector}</div> : <CollapsedTab label="检查器" side="right" onClick={props.onOpenRight} />}
      </div>
    </div>
  );
}

export function VariantB(props: LayoutProps) {
  return (
    <div className="layout-b">
      {props.topBar}
      <div className="gallery-workspace">
        <div className="gallery-rail">{props.preferences.leftOpen ? props.sidebar : <CollapsedTab label="分类" side="left" onClick={props.onOpenLeft} />}</div>
        {props.center}
        {props.preferences.rightOpen ? <div className="floating-inspector">{props.inspector}</div> : <CollapsedTab label="检查器" side="right" onClick={props.onOpenRight} />}
      </div>
    </div>
  );
}

export function VariantC(props: LayoutProps) {
  return (
    <div className="layout-c">
      {props.topBar}
      <div className="ledger-workspace">
        <div className="ledger-catalog">{props.preferences.leftOpen ? props.sidebar : <CollapsedTab label="分类" side="left" onClick={props.onOpenLeft} />}</div>
        <div className="ledger-center">{props.center}</div>
        <div className="ledger-inspector">{props.preferences.rightOpen ? props.inspector : <CollapsedTab label="检查器" side="right" onClick={props.onOpenRight} />}</div>
      </div>
    </div>
  );
}

function CollapsedTab({ label, side, onClick }: { label: string; side: "left" | "right"; onClick: () => void }) {
  return <button type="button" className={`collapsed-tab is-${side}`} onClick={onClick}>{label}</button>;
}

function Sidebar({
  library,
  folder,
  favoriteOnly,
  onFolder,
  onFavorite,
  onCollapse,
}: {
  library: LibraryKind;
  folder: string;
  favoriteOnly: boolean;
  onFolder: (folder: string) => void;
  onFavorite: () => void;
  onCollapse: () => void;
}) {
  const options = library === "images" ? imageFolderFixtures : promptFolderFixtures;
  return (
    <aside className="prototype-sidebar">
      <div className="panel-heading"><div><small>{library === "images" ? "IMAGE LIBRARY" : "PROMPT LIBRARY"}</small><h2>{library === "images" ? "图片分类" : "提示词分类"}</h2></div><button type="button" onClick={onCollapse} aria-label="折叠分类栏">‹</button></div>
      <nav className="sidebar-nav" aria-label="素材分类">
        <button type="button" className={folder === "全部" && !favoriteOnly ? "is-current" : ""} onClick={() => onFolder("全部")}><span>全部</span><strong>10k</strong></button>
        <button type="button" className={favoriteOnly ? "is-current" : ""} onClick={onFavorite}><span>☆ 收藏</span><strong>{library === "images" ? "589" : "770"}</strong></button>
        <div className="nav-separator"><span>我的文件夹</span><button type="button" aria-label="新建自定义文件夹">+</button></div>
        {options.map((option) => (
          <button type="button" key={option} className={folder === option ? "is-current" : ""} onClick={() => onFolder(option)}><span>{option}</span></button>
        ))}
        <div className="nav-separator"><span>我的共享标签</span><button type="button" aria-label="新建自定义标签">+</button></div>
        <div className="sidebar-tags">
          {tagFixtures.slice(0, 8).map((tag) => <button type="button" key={tag}>{tag}<small>{(tag.length * 137) % 900 + 24}</small></button>)}
        </div>
        <p className="fixture-disclaimer">原型示例名称，正式库中全部由你创建。</p>
        <button type="button" className="trash-entry"><span>回收站</span><strong>3</strong></button>
      </nav>
    </aside>
  );
}

function CollectionToolbar({ library, view, query, resultCount, selectedCount, onQuery, onView, onClearSelection }: {
  library: LibraryKind;
  view: ViewKind;
  query: string;
  resultCount: number;
  selectedCount: number;
  onQuery: (query: string) => void;
  onView: (view: ViewKind) => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="collection-toolbar">
      <div className="collection-title"><small>{library === "images" ? "IMAGE ASSETS" : "PROMPT ASSETS"}</small><h1>{library === "images" ? "图片素材" : "提示词"}</h1><span>{resultCount.toLocaleString()} 项</span></div>
      {selectedCount > 1 ? (
        <div className="batch-toolbar" role="toolbar" aria-label="批量操作">
          <strong>已选 {selectedCount.toLocaleString()}</strong>
          <button type="button">文件夹</button><button type="button">标签</button><button type="button">关联</button><button type="button">收藏</button><button type="button">回收站</button>
          <button type="button" onClick={onClearSelection}>取消</button>
        </div>
      ) : (
        <label className="local-search"><span>当前库搜索</span><input data-current-library-search type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder={library === "images" ? "文件名或标签…" : "标题、正文或标签…"} /></label>
      )}
      <div className="view-switcher" aria-label="视图模式">
        <button type="button" className={view === "masonry" ? "is-current" : ""} onClick={() => onView("masonry")}>瀑布流</button>
        <button type="button" className={view === "details" ? "is-current" : ""} onClick={() => onView("details")}>详情列表</button>
      </div>
    </div>
  );
}

function VisualTile({ item, compact = false }: { item: ImageFixture; compact?: boolean }) {
  const style: CSSProperties = {
    background: `linear-gradient(${115 + item.hue % 70}deg, hsl(${item.hue} 42% 78%), hsl(${(item.hue + 48) % 360} 36% 48%))`,
  };
  return <div className={`visual-tile ${compact ? "is-compact" : ""}`} role="img" aria-label={item.name} style={style}><span /><i /></div>;
}

function ImageCard({ item }: { item: ImageFixture }) {
  return <div className="image-card"><div className="card-visual" style={{ aspectRatio: `${item.width}/${item.height}` }}><VisualTile item={item} /></div><div className="card-copy"><strong>{item.name}</strong><span>{item.width} × {item.height}</span>{item.favorite && <b>★</b>}</div></div>;
}

function PromptCard({ item, coverId, linkedImageCount }: { item: PromptFixture; coverId: string | null; linkedImageCount: number }) {
  const cover = coverId === null ? null : imageById.get(coverId) ?? null;
  return <div className={`prompt-card ${cover === null ? "is-text-only" : ""}`}>{cover !== null && <div className="prompt-cover"><VisualTile item={cover} />{linkedImageCount > 1 && <span>+{linkedImageCount - 1}</span>}</div>}<div className="prompt-card-copy"><small>{item.folder}</small><strong>{titleForPrompt(item)}</strong><p>{item.text}</p><footer><span>{item.tags.join(" · ")}</span>{item.favorite && <b>★</b>}</footer></div></div>;
}

function ImageRow({ item }: { item: ImageFixture }) {
  return <div className="detail-row image-detail-row"><VisualTile item={item} compact /><strong>{item.name}</strong><span>{item.folder}</span><span>{item.tags.join(", ")}</span><span>{item.width} × {item.height}</span><span>{item.note || "—"}</span></div>;
}

function PromptRow({ item }: { item: PromptFixture }) {
  const cover = item.coverImageId === null ? null : imageById.get(item.coverImageId) ?? null;
  return <div className="detail-row prompt-detail-row">{cover === null ? <div className="text-cover">Aa</div> : <VisualTile item={cover} compact />}<strong>{titleForPrompt(item)}</strong><span>{item.text}</span><span>{item.folder}</span><span>{item.tags.join(", ")}</span><span>{item.linkedImageIds.length} 张</span></div>;
}

function Inspector({ library, activeId, selectedIds, tab, setTab, isLinked, onOpenRelations, coverOverrides, setCoverOverrides, getLinkedImages, onLocalFiles, onCollapse }: {
  library: LibraryKind;
  activeId: string | null;
  selectedIds: ReadonlySet<string>;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  isLinked: (imageId: string, promptId: string) => boolean;
  onOpenRelations: (kind: LibraryKind, id: string) => void;
  coverOverrides: ReadonlyMap<string, string>;
  setCoverOverrides: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  getLinkedImages: (prompt: PromptFixture) => string[];
  onLocalFiles: (promptId: string, count: number) => void;
  onCollapse: () => void;
}) {
  const selectedCount = selectedIds.size;
  if (selectedCount > 1) {
    return <aside className="prototype-inspector"><div className="panel-heading"><div><small>MULTI SELECT</small><h2>{selectedCount.toLocaleString()} 项</h2></div><button type="button" onClick={onCollapse}>›</button></div><div className="multi-summary"><p>共同标签</p><div className="tag-stack"><span>人物</span><span>混合值…</span></div><p>文件夹</p><button type="button" className="mixed-value">— 多个值 —</button><p>批量操作不覆盖正文或备注。</p></div></aside>;
  }
  if (activeId === null) return <aside className="prototype-inspector"><div className="panel-heading"><div><small>INSPECTOR</small><h2>检查器</h2></div><button type="button" onClick={onCollapse}>›</button></div><div className="inspector-empty"><strong>选择一项</strong><p>单击更新检查器，双击进入聚焦模式。</p></div></aside>;

  const image = library === "images" ? imageById.get(activeId) ?? null : null;
  const prompt = library === "prompts" ? promptById.get(activeId) ?? null : null;
  if (image === null && prompt === null) return null;
  const tabs: Array<{ id: InspectorTab; label: string }> = [
    { id: "info", label: "信息" }, { id: "organize", label: "组织" }, { id: "note", label: "备注" }, { id: "relations", label: library === "images" ? "提示词" : "关联图片" },
  ];
  return (
    <aside className="prototype-inspector">
      <div className="panel-heading"><div><small>{library === "images" ? "IMAGE INSPECTOR" : "PROMPT INSPECTOR"}</small><h2>{image?.name ?? (prompt === null ? "" : titleForPrompt(prompt))}</h2></div><button type="button" onClick={onCollapse}>›</button></div>
      <div className="inspector-tabs" role="tablist">{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? "is-current" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
      <div className="inspector-content">
        {tab === "info" && image !== null && <><div className="inspector-preview"><VisualTile item={image} /></div><dl><dt>尺寸</dt><dd>{image.width} × {image.height}</dd><dt>文件夹</dt><dd>{image.folder}</dd><dt>关联提示词</dt><dd>{promptFixtures.slice(0, 300).filter((item) => isLinked(image.id, item.id)).length}</dd></dl></>}
        {tab === "info" && prompt !== null && <><div className="prompt-full-text">{prompt.text}</div><dl><dt>模型/平台</dt><dd>{prompt.model ?? "未指定"}</dd><dt>关联图片</dt><dd>{getLinkedImages(prompt).length}</dd></dl><button type="button" className="primary-action">编辑提示词</button></>}
        {tab === "organize" && <><label>自定义文件夹<select defaultValue={image?.folder ?? prompt?.folder}>{(library === "images" ? imageFolderFixtures : promptFolderFixtures).map((folder) => <option key={folder}>{folder}</option>)}</select></label><p>自定义共享标签</p><div className="tag-stack">{(image?.tags ?? prompt?.tags ?? []).map((tag) => <span key={tag}>{tag} ×</span>)}</div><button type="button">+ 输入新标签</button><button type="button">☆ 收藏</button></>}
        {tab === "note" && <label>多行纯文本<textarea defaultValue={image?.note ?? prompt?.note} rows={8} /></label>}
        {tab === "relations" && image !== null && <><button type="button" className="primary-action" onClick={() => onOpenRelations("images", image.id)}>关联提示词</button><div className="relation-list">{promptFixtures.slice(0, 20).filter((item) => isLinked(image.id, item.id)).slice(0, 5).map((item) => <article key={item.id}><strong>{titleForPrompt(item)}</strong><p>{item.text}</p></article>)}</div></>}
        {tab === "relations" && prompt !== null && (() => {
          const linkedImageIds = getLinkedImages(prompt);
          const requestedCover = coverOverrides.get(prompt.id) ?? prompt.coverImageId;
          const coverId = requestedCover !== null && linkedImageIds.includes(requestedCover) ? requestedCover : linkedImageIds[0] ?? null;
          return <><div className="relation-actions"><button type="button" className="primary-action" onClick={() => onOpenRelations("prompts", prompt.id)}>从图片库选择</button><label className="file-action">从本地导入<input type="file" accept="image/*" multiple onChange={(event) => onLocalFiles(prompt.id, event.target.files?.length ?? 0)} /></label></div><div className="relation-thumbnails">{linkedImageIds.slice(0, 6).map((id) => { const related = imageById.get(id); if (related === undefined) return null; return <button type="button" key={id} className={coverId === id ? "is-cover" : ""} onClick={() => setCoverOverrides((current) => new Map(current).set(prompt.id, id))}><VisualTile item={related} compact /><span>{coverId === id ? "封面" : "设为封面"}</span></button>; })}</div></>;
        })()}
      </div>
    </aside>
  );
}

function FocusOverlay({ library, id, onClose }: { library: LibraryKind; id: string; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const image = library === "images" ? imageById.get(id) ?? null : null;
  const prompt = library === "prompts" ? promptById.get(id) ?? null : null;
  return <div className="focus-overlay" role="dialog" aria-modal="true"><button type="button" className="focus-close" onClick={onClose}>Esc 返回</button>{image !== null && <div className="focus-image"><VisualTile item={image} /><h2>{image.name}</h2></div>}{prompt !== null && <div className="focus-prompt"><small>PROMPT FOCUS</small><h2>{titleForPrompt(prompt)}</h2><p>{prompt.text}</p><button type="button">复制正文</button></div>}</div>;
}

function RelationPicker({ target, isLinked, onToggle, onClose }: { target: Exclude<RelationDialog, null>; isLinked: (imageId: string, promptId: string) => boolean; onToggle: (imageId: string, promptId: string) => void; onClose: () => void }) {
  const candidates = target.kind === "prompts" ? imageFixtures.slice(0, 12) : promptFixtures.slice(0, 12);
  return <div className="modal-backdrop"><section className="relation-picker" role="dialog" aria-modal="true"><header><div><small>ORDINARY LINK</small><h2>{target.kind === "prompts" ? "从图片库选择" : "关联提示词"}</h2></div><button type="button" onClick={onClose}>完成</button></header><input type="search" placeholder="在当前库搜索…" /><div className="picker-grid">{candidates.map((candidate) => { const imageId = target.kind === "prompts" ? candidate.id : target.id; const promptId = target.kind === "prompts" ? target.id : candidate.id; const linked = isLinked(imageId, promptId); return <button type="button" key={candidate.id} className={linked ? "is-selected" : ""} onClick={() => onToggle(imageId, promptId)}>{target.kind === "prompts" ? <><VisualTile item={candidate as ImageFixture} compact /><span>{(candidate as ImageFixture).name}</span></> : <><strong>{titleForPrompt(candidate as PromptFixture)}</strong><span>{(candidate as PromptFixture).text}</span></>}{linked && <b>✓</b>}</button>; })}</div><footer>这只是普通关联，不声明生成、参考或反推来源。</footer></section></div>;
}

function GlobalSearch({ query, onQuery, onClose, onLocate }: { query: string; onQuery: (query: string) => void; onClose: () => void; onLocate: (kind: LibraryKind, id: string) => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const lowered = query.toLocaleLowerCase();
  const images = imageFixtures.filter((item) => item.name.includes(lowered) || item.tags.some((tag) => tag.includes(lowered))).slice(0, 4);
  const prompts = promptFixtures.filter((item) => item.text.toLocaleLowerCase().includes(lowered) || titleForPrompt(item).includes(query)).slice(0, 4);
  return <div className="modal-backdrop search-backdrop"><section className="global-search" role="dialog" aria-modal="true"><header><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索图片和提示词…" /><button type="button" onClick={onClose}>Esc</button></header><div className="search-groups"><SearchGroup title={`图片素材（${images.length}）`} items={images.map((item) => ({ id: item.id, title: item.name, detail: item.tags.join(" · ") }))} onPick={(id) => onLocate("images", id)} /><SearchGroup title={`提示词（${prompts.length}）`} items={prompts.map((item) => ({ id: item.id, title: titleForPrompt(item), detail: item.text }))} onPick={(id) => onLocate("prompts", id)} /></div></section></div>;
}

function SearchGroup({ title, items, onPick }: { title: string; items: Array<{ id: string; title: string; detail: string }>; onPick: (id: string) => void }) {
  return <section><h3>{title}</h3>{items.map((item) => <button type="button" key={item.id} onClick={() => onPick(item.id)}><strong>{item.title}</strong><span>{item.detail}</span></button>)}</section>;
}

function PrototypeSwitcher({ variant, onVariant, engine, onEngine, state }: { variant: Variant; onVariant: (variant: Variant) => void; engine: VirtualEngine; onEngine: (engine: VirtualEngine) => void; state: string }) {
  useEffect(() => {
    const cycle = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button, input, textarea, select, [contenteditable], .collection-keyboard-surface") !== null) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = variants.indexOf(variant);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      onVariant(variants[(index + delta + variants.length) % variants.length] ?? "A");
    };
    window.addEventListener("keydown", cycle);
    return () => window.removeEventListener("keydown", cycle);
  }, [onVariant, variant]);
  const index = variants.indexOf(variant);
  return <div className="prototype-switcher"><button type="button" onClick={() => onVariant(variants[(index - 1 + variants.length) % variants.length] ?? "A")}>←</button><div><strong>{variant} — {variantNames[variant]}</strong><span>{state}</span><button type="button" onClick={() => onEngine(engine === "owned" ? "tanstack" : "owned")}>虚拟化：{engine === "owned" ? "自有基线" : "TanStack 3.14.10"}</button></div><button type="button" onClick={() => onVariant(variants[(index + 1) % variants.length] ?? "A")}>→</button></div>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("原型根节点不存在");
createRoot(root).render(<PrototypeApp />);
