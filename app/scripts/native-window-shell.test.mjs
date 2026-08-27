import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);

test("主窗口保留 Windows 原生标题栏且允许进入批准的窄窗口断点", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const [mainWindow] = config.app.windows;
  assert.notEqual(mainWindow.decorations, false);
  assert.notEqual(mainWindow.transparent, true);
  assert.notEqual(mainWindow.titleBarStyle, "Overlay");
  assert.ok(mainWindow.minWidth <= 760, `minWidth=${mainWindow.minWidth} 阻止 760px 窄窗口验收`);
});
