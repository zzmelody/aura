import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@aura/workbench";

window.auraHost = { platform: "desktop" };

const root = document.getElementById("root");
if (!root) throw new Error("Aura root element is missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
