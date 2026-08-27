import { useState, type ReactNode } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { ImageSquareIcon } from "@phosphor-icons/react/dist/csr/ImageSquare";

import { Button, IconButton } from "../../ui/button/Button";
import { ConfirmDialog, Dialog, DialogClose } from "../../ui/dialog/Dialog";
import { Menu, MenuCheckboxItem, MenuItem, MenuSeparator } from "../../ui/overlays/Menu";
import { Popover } from "../../ui/overlays/Popover";
import { Tooltip } from "../../ui/overlays/Tooltip";
import { Progress } from "../../ui/progress/Progress";
import { SearchField } from "../../ui/search-field/SearchField";
import { Select } from "../../ui/select/Select";
import { ScrollArea } from "../../ui/surface/ScrollArea";
import { EmptyState, Panel, Toolbar } from "../../ui/surface/Surface";
import { useTheme } from "../../ui/theme/ThemeProvider";
import { useToast } from "../../ui/toast/Toast";
import styles from "./UiKitShowcase.module.css";

const SORT_OPTIONS = [
  { value: "recent", label: "最近导入" },
  { value: "filename", label: "文件名" },
] as const;

export function UiKitShowcase(): ReactNode {
  const [search, setSearch] = useState("雨夜");
  const [sort, setSort] = useState("recent");
  const [showMetadata, setShowMetadata] = useState(true);
  const { setPreference, snapshot } = useTheme();
  const toast = useToast();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p>VISTASH UI</p>
          <h1>Archive Desk 组件系统</h1>
        </div>
        <div className={styles.themeControls} role="group" aria-label="主题预览">
          {(["system", "dark", "light"] as const).map((preference) => (
            <Button
              key={preference}
              size="compact"
              variant={snapshot.preference === preference ? "primary" : "secondary"}
              onClick={() => setPreference(preference)}
            >
              {preference === "system" ? "跟随系统" : preference === "dark" ? "深色" : "浅色"}
            </Button>
          ))}
        </div>
      </header>

      <section className={styles.section}>
        <h2>操作</h2>
        <div className={styles.row}>
          <Button variant="primary">导入图片</Button>
          <Button>移动到文件夹</Button>
          <Button variant="ghost">取消</Button>
          <Button variant="danger">移入回收站</Button>
          <Button loading loadingLabel="正在导入…">导入图片</Button>
          <Tooltip content="打开设置">
            <IconButton label="打开设置" icon={<GearIcon />} />
          </Tooltip>
        </div>
      </section>

      <section className={styles.section}>
        <h2>查询与状态</h2>
        <Toolbar label="素材工具">
          <SearchField
            label="搜索图片"
            name="ui-kit-search"
            placeholder="按文件名搜索…"
            value={search}
            onValueChange={setSearch}
            shortcut="Ctrl F"
          />
          <Select
            label="排序方式"
            name="ui-kit-sort"
            value={sort}
            options={SORT_OPTIONS}
            onValueChange={setSort}
          />
          <Popover trigger={<Button startIcon={<FunnelIcon />}>筛选</Button>} label="图片筛选" showClose>
            <div className={styles.popoverCopy}>
              <strong>筛选图片</strong>
              <p>文件夹、标签和收藏条件将在图片模块中接入。</p>
            </div>
          </Popover>
          <Menu trigger={<IconButton label="更多操作" icon={<DotsThreeIcon />} />} label="更多操作">
            <MenuItem>导出原图</MenuItem>
            <MenuCheckboxItem checked={showMetadata} onCheckedChange={setShowMetadata}>
              显示元数据
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem destructive>移入回收站</MenuItem>
          </Menu>
        </Toolbar>
        <div className={styles.progressGrid}>
          <Progress label="正在导入 42/100" value={42} max={100} />
          <Progress label="正在扫描文件夹" value={null} />
        </div>
      </section>

      <section className={styles.section}>
        <h2>浮层与反馈</h2>
        <div className={styles.row}>
          <Dialog
            trigger={<Button>打开 Dialog</Button>}
            title="素材设置"
            description="修改当前素材的显示和组织方式。"
            footer={<DialogClose><Button variant="primary">完成</Button></DialogClose>}
          >
            <p className={styles.dialogCopy}>Dialog 保持稳定标题区、可滚动内容区和明确操作区。</p>
          </Dialog>
          <ConfirmDialog
            trigger={<Button variant="danger">永久删除</Button>}
            title="永久删除所选素材？"
            description="删除后无法从 Vistash 回收站恢复。"
            confirmLabel="永久删除"
            onConfirm={() => toast.publish({ tone: "warning", title: "示例确认已执行" })}
          />
          <Button
            onClick={() =>
              toast.publish({ tone: "success", title: "已复制图像", description: "可以粘贴到其他应用。" })
            }
          >
            显示 Toast
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h2>容器与空状态</h2>
        <div className={styles.surfaceGrid}>
          <Panel label="滚动区域" className={styles.scrollPanel}>
            <ScrollArea label="文件夹列表">
              <div className={styles.list}>
                {Array.from({ length: 14 }, (_value, index) => (
                  <button type="button" key={index}>参考资料 / 集合 {index + 1}</button>
                ))}
              </div>
            </ScrollArea>
          </Panel>
          <Panel label="空素材库">
            <EmptyState
              icon={<ImageSquareIcon />}
              title="还没有图片"
              description="导入图片或文件夹开始整理，本地源文件不会被修改。"
              primaryAction={<Button variant="primary">导入图片</Button>}
              secondaryAction={<Button>导入文件夹</Button>}
            />
          </Panel>
        </div>
      </section>
    </main>
  );
}
