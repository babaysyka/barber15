import WebApp from "@twa-dev/sdk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

WebApp.ready();
WebApp.expand();

const root = document.getElementById("root");
if (!root) {
  throw new Error("root missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
