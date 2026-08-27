import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ICON_ROOT = new URL("../src-tauri/icons/", import.meta.url);

async function pngDimensions(filename) {
  const bytes = await readFile(new URL(filename, ICON_ROOT));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("生产品牌 PNG 覆盖评审冻结的全部尺寸", async () => {
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    assert.deepEqual(await pngDimensions(`${size}x${size}.png`), [size, size]);
  }
});

test("Windows ICO 含任务栏与高分辨率所需帧", async () => {
  const bytes = await readFile(new URL("icon.ico", ICON_ROOT));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_value, index) => {
    const width = bytes[6 + index * 16];
    return width === 0 ? 256 : width;
  });
  assert.deepEqual(sizes.toSorted((a, b) => a - b), [16, 24, 32, 48, 64, 256]);
});

test("Tauri bundle 显式登记 Windows 应用图标", async () => {
  const configText = await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");
  const config = JSON.parse(configText);
  assert.deepEqual(config.bundle.icon, [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.ico",
  ]);
});
