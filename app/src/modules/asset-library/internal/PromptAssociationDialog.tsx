import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { parseAssetId, type LibraryId } from "../../../app/common";
import { asAppError, IpcError } from "../../../shared/errors";
import { createPrompt, promptSnapshot } from "../../../shared/ipc";
import type { AppError, AssetRow, NewPromptInput, PromptAsset, PromptRow } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import { SearchField } from "../../../ui/search-field/SearchField";
import { blockIfPromptDraftDirty, setPromptDraftGuard } from "../../../features/prompts/draftGuard";
import { PromptDraftGuardDialog } from "../../../features/prompts/PromptDraftGuardDialog";
import type { ImagePromptRelations, RelationFailure } from "../../image-prompt-relations";
import { AssetThumbnail } from "./AssetCollection";
import { promptTitle } from "./AssetPromptLinks";
import { assetKeys } from "./queryKeys";
import styles from "./PromptAssociationDialog.module.css";

const MAX_VISIBLE_TARGETS = 6;
const MAX_VISIBLE_CANDIDATES = 50;

function promptSummary(prompt: PromptRow): string {
  return prompt.body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 2).join(" ");
}

function linkedTargetCount(prompt: PromptRow, targets: readonly AssetRow[]): number {
  const linked = new Set(prompt.linked_image_hashes);
  return targets.reduce((count, asset) => count + (linked.has(asset.hash) ? 1 : 0), 0);
}

function nullable(value: string): string | null {
  return value.trim().length === 0 ? null : value;
}

type CreateOutcome =
  | { kind: "create_failed"; error: AppError }
  | { kind: "linked"; prompt: PromptAsset }
  | { kind: "refresh_failed"; prompt: PromptAsset; error: AppError }
  | { kind: "link_failed"; prompt: PromptAsset; failures: readonly RelationFailure[]; refreshError: AppError | null };

type Props = {
  active: boolean;
  libraryId: LibraryId;
  relations: ImagePromptRelations;
  targets: readonly AssetRow[];
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
};

export function PromptAssociationDialog(props: Props): ReactNode {
  const { targets } = props;
  if (targets.length === 0) throw new Error("图片关联台至少需要一张冻结目标图片");
  return <PromptAssociationSession {...props} />;
}

function PromptAssociationSession({ active, libraryId, relations, targets, onClose, onCloseAutoFocus }: Props): ReactNode {
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selectedPrompts, setSelectedPrompts] = useState<readonly PromptRow[]>([]);
  const [failures, setFailures] = useState<readonly RelationFailure[]>([]);
  const [refreshError, setRefreshError] = useState<AppError | null>(null);
  const [refreshPromptIds, setRefreshPromptIds] = useState<readonly string[]>([]);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [parameters, setParameters] = useState("");
  const [body, setBody] = useState("");
  const [createdPrompt, setCreatedPrompt] = useState<PromptAsset | null>(null);
  const [createError, setCreateError] = useState<AppError | null>(null);
  const [createFailures, setCreateFailures] = useState<readonly RelationFailure[]>([]);
  const [createRefreshError, setCreateRefreshError] = useState<AppError | null>(null);
  const [confirmDraft, setConfirmDraft] = useState(false);
  const dirtyRef = useRef(false);
  const pendingContinuationRef = useRef<(() => void) | null>(null);
  const candidates = useQuery({
    queryKey: assetKeys.promptCandidates(libraryId, deferredSearch),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await promptSnapshot({ text: deferredSearch, tags: [], folder: { kind: "all" }, favorite: null, location: "active" });
      signal.throwIfAborted();
      return result.prompts;
    },
    enabled: active,
  });
  const save = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (promptIds: readonly string[]) => relations.execute({
      kind: "link",
      libraryId,
      images: targets.map((asset) => parseAssetId(asset.hash)),
      prompts: promptIds,
    }),
    onSuccess: (commit, promptIds) => {
      setFailures(commit.failures);
      setRefreshError(commit.refreshError);
      if (commit.failures.length === 0 && commit.refreshError === null) {
        onClose();
        return;
      }
      const failedIds = new Set(commit.failures.map((failure) => failure.promptId));
      setSelectedPrompts((current) => current.filter((prompt) => failedIds.has(prompt.id)));
      if (commit.refreshError !== null) {
        setRefreshPromptIds(promptIds);
      }
    },
  });
  const refreshRelations = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (promptIds: readonly string[]) => relations.synchronize(libraryId, {
      imageIds: targets.map((asset) => parseAssetId(asset.hash)),
      promptIds,
    }),
  });
  const createAndLink = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: async (request: { kind: "create"; draft: NewPromptInput } | { kind: "retry"; prompt: PromptAsset }): Promise<CreateOutcome> => {
      let prompt: PromptAsset;
      if (request.kind === "create") {
        try {
          prompt = await createPrompt(request.draft);
        } catch (raw) {
          return { kind: "create_failed", error: asAppError(raw) };
        }
      } else {
        prompt = request.prompt;
      }
      const commit = await relations.execute({
        kind: "link",
        libraryId,
        images: targets.map((asset) => parseAssetId(asset.hash)),
        prompts: [prompt.id],
      });
      if (commit.failures.length === 0 && commit.refreshError === null) return { kind: "linked", prompt };
      if (commit.failures.length === 0 && commit.refreshError !== null) return { kind: "refresh_failed", prompt, error: commit.refreshError };
      return { kind: "link_failed", prompt, failures: commit.failures, refreshError: commit.refreshError };
    },
  });
  for (const error of [candidates.error, save.error, createAndLink.error, refreshRelations.error]) if (error !== null && !(error instanceof IpcError)) throw error;

  const selectedIds = useMemo(() => selectedPrompts.map((prompt) => prompt.id), [selectedPrompts]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const newRelationCount = selectedPrompts.reduce((count, prompt) => count + targets.length - linkedTargetCount(prompt, targets), 0);
  const visibleTargets = targets.slice(0, MAX_VISIBLE_TARGETS);
  const visibleCandidates = candidates.data?.slice(0, MAX_VISIBLE_CANDIDATES) ?? [];
  const busy = save.isPending || createAndLink.isPending || refreshRelations.isPending;
  const querySettled = !candidates.isFetching && search === deferredSearch;
  const dirty = createdPrompt === null && (title.length > 0 || model.length > 0 || parameters.length > 0 || body.length > 0);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    setPromptDraftGuard({
      isDirty: () => dirtyRef.current,
      requestResolve: (continueAction) => {
        pendingContinuationRef.current = continueAction;
        setConfirmDraft(true);
      },
    });
    return () => setPromptDraftGuard(null);
  }, []);

  const createRequest = (): { kind: "create"; draft: NewPromptInput } | { kind: "retry"; prompt: PromptAsset } => createdPrompt === null
    ? { kind: "create", draft: { body, title: nullable(title), model: nullable(model), parameters: nullable(parameters), folders: [], tags: [] } }
    : { kind: "retry", prompt: createdPrompt };

  const applyCreateOutcome = (outcome: CreateOutcome): boolean => {
    setCreateError(null);
    if (outcome.kind === "create_failed") {
      setCreateError(outcome.error);
      return false;
    }
    dirtyRef.current = false;
    if (outcome.kind === "linked") return true;
    if (outcome.kind === "refresh_failed") {
      setCreatedPrompt(outcome.prompt);
      setCreateFailures([]);
      setCreateRefreshError(outcome.error);
      return false;
    }
    setCreatedPrompt(outcome.prompt);
    setCreateFailures(outcome.failures);
    setCreateRefreshError(outcome.refreshError);
    return false;
  };

  const runCreate = async (continueAction?: () => void): Promise<void> => {
    if (body.trim().length === 0 || busy) return;
    setCreateError(null);
    setCreateFailures([]);
    setCreateRefreshError(null);
    const outcome = await createAndLink.mutateAsync(createRequest());
    if (!applyCreateOutcome(outcome)) return;
    onClose();
    continueAction?.();
  };

  const retryExistingRefresh = async (): Promise<void> => {
    const error = await refreshRelations.mutateAsync(refreshPromptIds);
    setRefreshError(error);
    if (error === null && failures.length === 0) onClose();
  };

  const retryCreateRefresh = async (): Promise<void> => {
    if (createdPrompt === null) throw new Error("创建结果刷新缺少提示词身份");
    const error = await refreshRelations.mutateAsync([createdPrompt.id]);
    setCreateRefreshError(error);
    if (error === null) onClose();
  };

  const footer = mode === "existing" ? <>
    <div className={styles.footerSummary}>已选图片 {targets.length} 张 · 已选提示词 {selectedIds.length} 条 · 将新增 {newRelationCount} 条关系</div>
    {refreshError === null
      ? <Button variant="primary" disabled={busy || selectedIds.length === 0 || newRelationCount === 0 || !querySettled} onClick={() => save.mutate(selectedIds)}>{busy ? "正在建立关联…" : `建立 ${newRelationCount} 条普通关联`}</Button>
      : <Button variant="primary" disabled={busy} onClick={() => void retryExistingRefresh()}>{busy ? "正在刷新…" : "重试刷新"}</Button>}
  </> : <>
    <div className={styles.footerSummary}>将在提示词根位置创建 1 条提示词，并关联到 {targets.length} 张图片</div>
    {createdPrompt === null
      ? <Button variant="primary" disabled={busy || body.trim().length === 0} onClick={() => void runCreate()}>{busy ? "正在创建…" : `创建提示词并关联到 ${targets.length} 张图片`}</Button>
      : createFailures.length === 0 && createRefreshError !== null
        ? <Button variant="primary" disabled={busy} onClick={() => void retryCreateRefresh()}>{busy ? "正在刷新…" : "重试刷新"}</Button>
        : <Button variant="primary" disabled={busy} onClick={() => void runCreate()}>{busy ? "正在重试关联…" : `重试关联到 ${targets.length} 张图片`}</Button>}
  </>;

  return <Dialog
    title="图片 × 提示词关联"
    description="在当前图片上下文中选择已有提示词并建立普通关联。"
    size="wide"
    open={active}
    footer={footer}
    onOpenChange={(open) => { if (!open && !blockIfPromptDraftDirty(onClose)) onClose(); }}
    {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
  >
    <div className={styles.workbench}>
      <section className={styles.targets} aria-labelledby="association-targets-heading">
        <div className={styles.heading}><h3 id="association-targets-heading">已选图片</h3><p>{targets.length} 张</p></div>
        <ul className={styles.targetGrid}>{visibleTargets.map((asset) => <li key={asset.hash}>
          <span className={styles.targetMedia}><AssetThumbnail asset={asset} /></span>
          <span className={styles.targetName}>{asset.display_filename}</span>
        </li>)}</ul>
        {targets.length > visibleTargets.length ? <p className={styles.moreTargets}>另有 {targets.length - visibleTargets.length} 张图片</p> : null}
        <p className={styles.hint}>本次目标已冻结；底层集合变化不会改变这些图片。</p>
      </section>

      <section className={styles.prompts} aria-labelledby="association-prompts-heading">
        <div className={styles.modeTabs} role="group" aria-label="关联方式">
          <Button size="compact" variant="ghost" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>选择已有</Button>
          <Button size="compact" variant="ghost" aria-pressed={mode === "create"} onClick={() => setMode("create")}>新建提示词</Button>
        </div>
        {mode === "existing" ? <>
          <div className={styles.heading}><h3 id="association-prompts-heading">选择提示词</h3><p>已选提示词 {selectedIds.length} 条</p></div>
          <SearchField label="搜索标题或正文" name="association-prompt-search" placeholder="搜索标题或正文…" value={search} disabled={busy} onValueChange={setSearch} />
          {candidates.isError ? <div><p role="alert" className={styles.error}>{candidates.error.message}</p><Button size="compact" onClick={() => void candidates.refetch()}>重试读取提示词</Button></div>
            : candidates.isPending ? <p role="status">正在读取提示词…</p>
              : visibleCandidates.length === 0 ? <p className={styles.hint}>没有匹配的正常提示词。</p>
                : <>
                  <ul className={styles.candidateList}>{visibleCandidates.map((prompt) => {
                    const linkedCount = linkedTargetCount(prompt, targets);
                    const fullyLinked = linkedCount === targets.length;
                    const checked = fullyLinked || selectedSet.has(prompt.id);
                    const relationState = fullyLinked ? "已关联" : linkedCount > 0 ? `已关联 ${linkedCount}/${targets.length} 张` : prompt.model ?? "未填写模型";
                    return <li key={prompt.id}><label>
                      <input type="checkbox" value={prompt.id} checked={checked} disabled={fullyLinked || busy || !querySettled} onChange={() => setSelectedPrompts((current) => current.some((item) => item.id === prompt.id) ? current.filter((item) => item.id !== prompt.id) : [...current, prompt])} />
                      <span className={styles.candidateText}><strong>{promptTitle(prompt)}</strong><span>{promptSummary(prompt)}</span><em>{relationState}</em></span>
                    </label></li>;
                  })}</ul>
                  {(candidates.data?.length ?? 0) > visibleCandidates.length ? <p className={styles.resultCount}>当前只显示前 {MAX_VISIBLE_CANDIDATES} 条，请继续搜索以缩小结果。</p> : null}
                </>}
          {failures.length === 0 ? null : <ul className={styles.failures} aria-label="关联失败">{failures.map((failure) => {
            const prompt = selectedPrompts.find((item) => item.id === failure.promptId) ?? candidates.data?.find((item) => item.id === failure.promptId);
            if (prompt === undefined) throw new Error(`关联失败提示词不在候选中：${failure.promptId}`);
            return <li key={failure.promptId}><strong>{promptTitle(prompt)}</strong><code>{failure.error.code}</code><span>{failure.error.detail}</span></li>;
          })}</ul>}
          {refreshError === null ? null : <p role="alert" className={styles.error}>关系已写入、刷新失败。重试只重新读取，不会撤销关联。{refreshError.code}：{refreshError.detail}</p>}
        </> : <>
          <div className={styles.heading}><h3 id="association-prompts-heading">新建提示词</h3><p>正文由你手动填写</p></div>
          <div className={styles.createForm}>
            <label className={styles.createField}><span>标题 <small>可选</small></span><input name="association-create-title" autoComplete="off" value={title} disabled={busy || createdPrompt !== null} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
            <div className={styles.createPair}>
              <label className={styles.createField}><span>模型 / 平台 <small>可选</small></span><input name="association-create-model" autoComplete="off" value={model} disabled={busy || createdPrompt !== null} onChange={(event) => setModel(event.currentTarget.value)} /></label>
              <label className={styles.createField}><span>参数说明 <small>可选</small></span><input name="association-create-parameters" autoComplete="off" value={parameters} disabled={busy || createdPrompt !== null} onChange={(event) => setParameters(event.currentTarget.value)} /></label>
            </div>
            <label className={styles.createField}><span>提示词正文</span><textarea name="association-create-body" autoComplete="off" value={body} disabled={busy || createdPrompt !== null} onChange={(event) => setBody(event.currentTarget.value)} /></label>
          </div>
          {createError === null ? null : <p role="alert" className={styles.error}>{createError.code}：{createError.detail}</p>}
          {createdPrompt === null ? null : <div className={styles.createdNotice} role="alert"><strong>{createFailures.length === 0 ? "提示词已创建、关系已写入、刷新失败" : "提示词已创建、关联失败"}</strong><p>{createFailures.length === 0 ? "权威关系已经写入；重试只重新读取界面状态。" : "新提示词已保留在提示词根位置；重试只建立普通关联。"}</p>{createFailures.map((failure) => <code key={failure.promptId}>{failure.error.code}：{failure.error.detail}</code>)}{createRefreshError === null ? null : <code>{createRefreshError.code}：{createRefreshError.detail}</code>}</div>}
        </>}
      </section>
    </div>
    {confirmDraft ? <PromptDraftGuardDialog
      saving={busy}
      description="创建后继续、放弃草稿，还是留在当前图片关联台？"
      discardLabel="放弃草稿"
      saveLabel="创建并继续"
      onStay={() => { pendingContinuationRef.current = null; setConfirmDraft(false); }}
      onDiscard={() => {
        dirtyRef.current = false;
        const continuation = pendingContinuationRef.current;
        pendingContinuationRef.current = null;
        setConfirmDraft(false);
        onClose();
        continuation?.();
      }}
      onSaveAndLeave={() => {
        const continuation = pendingContinuationRef.current;
        if (continuation === null) throw new Error("草稿保存并继续缺少后续动作");
        void runCreate(() => {
          pendingContinuationRef.current = null;
          setConfirmDraft(false);
          continuation();
        }).then(() => {
          if (dirtyRef.current) setConfirmDraft(false);
          return undefined;
        });
      }}
    /> : null}
  </Dialog>;
}
