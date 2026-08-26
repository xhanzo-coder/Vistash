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

const search = new URLSearchParams(window.location.search);
const showImageLibraryPrototype =
  import.meta.env.DEV && search.get("prototype") === "image-library";
const root = createRoot(container);

if (showImageLibraryPrototype) {
  void import("./prototypes/image-library/ImageLibraryPrototype").then(
    ({ ImageLibraryPrototype }) =>
      root.render(
        <StrictMode>
          <ImageLibraryPrototype />
        </StrictMode>,
      ),
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
