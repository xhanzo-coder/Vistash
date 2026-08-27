import {
  useDeferredValue,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ImageSquareIcon } from "@phosphor-icons/react/dist/csr/ImageSquare";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";

import { asAppError, formatError } from "../../shared/errors";
import type { GlobalSearchResult, PromptRow } from "../../shared/types";
import { Button } from "../../ui/button/Button";
import { Dialog } from "../../ui/dialog/Dialog";
import { SearchField } from "../../ui/search-field/SearchField";
import type { GlobalSearch, GlobalSearchSelection } from "../globalSearch";
import { locateRequestFromSelection } from "../globalSearch";
import type { WorkspaceNavigation } from "../navigation";
import styles from "./GlobalSearchDialog.module.css";

type SearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | { kind: "ready"; query: string; result: GlobalSearchResult }
  | { kind: "failed"; query: string; message: string };

function promptLabel(prompt: PromptRow): string {
  return prompt.title === null ? prompt.body : prompt.title;
}

export function GlobalSearchDialog({
  search,
  navigation,
}: {
  search: GlobalSearch;
  navigation: WorkspaceNavigation;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const text = deferredQuery.trim();
    if (!open || text.length === 0) return undefined;

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setState({ kind: "loading", query: text });
      void search.run(text).then(
        (result) => {
          if (!cancelled) setState({ kind: "ready", query: text, result });
          return undefined;
        },
        (raw: unknown) => {
          if (!cancelled) {
            setState({ kind: "failed", query: text, message: formatError(asAppError(raw)) });
          }
          return undefined;
        },
      );
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [deferredQuery, open, search]);

  const choose = (selection: GlobalSearchSelection): void => {
    navigation.requestLocate(locateRequestFromSelection(selection));
    setOpen(false);
    setQuery("");
  };

  const normalizedQuery = deferredQuery.trim();
  const visibleState: SearchState =
    normalizedQuery.length === 0
      ? { kind: "idle" }
      : state.kind === "idle" || state.query !== normalizedQuery
        ? { kind: "loading", query: normalizedQuery }
        : state;

  const body = (() => {
    if (visibleState.kind === "idle") {
      return <p className={styles.empty}>输入文件名、标签、标题或提示词正文。</p>;
    }
    if (visibleState.kind === "loading") {
      return <p className={styles.empty} role="status">正在搜索…</p>;
    }
    if (visibleState.kind === "failed") {
      return <p className={styles.error} role="alert">{visibleState.message}</p>;
    }
    const count = visibleState.result.assets.length + visibleState.result.prompts.length;
    if (count === 0) return <p className={styles.empty}>没有找到匹配素材。</p>;
    return (
      <div className={styles.results}>
        {visibleState.result.assets.length === 0 ? null : (
          <section aria-labelledby="global-assets-heading">
            <h3 id="global-assets-heading">图片</h3>
            {visibleState.result.assets.map((asset) => (
              <button key={asset.hash} type="button" onClick={() => choose({ kind: "asset", row: asset })}>
                <ImageSquareIcon aria-hidden="true" />
                <span><strong>{asset.display_filename}</strong><small>{asset.folder ?? "未分类"}</small></span>
              </button>
            ))}
          </section>
        )}
        {visibleState.result.prompts.length === 0 ? null : (
          <section aria-labelledby="global-prompts-heading">
            <h3 id="global-prompts-heading">提示词</h3>
            {visibleState.result.prompts.map((prompt) => (
              <button key={prompt.id} type="button" onClick={() => choose({ kind: "prompt", row: prompt })}>
                <NotePencilIcon aria-hidden="true" />
                <span><strong>{promptLabel(prompt)}</strong><small>{prompt.body}</small></span>
              </button>
            ))}
          </section>
        )}
      </div>
    );
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          className={styles.trigger}
          variant="ghost"
          startIcon={<MagnifyingGlassIcon />}
          endIcon={<kbd>Ctrl K</kbd>}
        >
          搜索全部素材
        </Button>
      }
      title="搜索全部素材"
      description="同时查找图片和提示词。选择结果会切换到对应工作区。"
    >
      <div className={styles.searchBody}>
        <SearchField
          autoFocus
          label="搜索全部素材"
          name="global-search"
          placeholder="搜索图片与提示词…"
          value={query}
          onValueChange={setQuery}
        />
        {body}
      </div>
    </Dialog>
  );
}
