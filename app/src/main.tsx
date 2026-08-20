import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  // 挂载点缺失意味着构建产物与 index.html 不一致。此处必须抛出而不是静默返回：
  // 静默返回的结果是一个纯白窗口，看不出白屏的原因是挂载失败还是渲染失败。
  throw new Error("找不到 #root 挂载点，index.html 与构建产物不一致");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
