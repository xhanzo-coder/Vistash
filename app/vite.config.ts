import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 在开发模式下访问固定端口，端口被占用时必须直接失败而不是静默换端口，
// 否则 Tauri 窗口会加载到一个空白页而看不出原因。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri 由 cargo 监听，Vite 再监听一遍会造成重复重启。
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome120",
    sourcemap: true,
  },
});
