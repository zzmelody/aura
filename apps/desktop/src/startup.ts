import { startStartupField } from "./startup-field.ts";

export interface DesktopStartup {
  ready(state: { reduced: boolean }): void;
  fail(): void;
  dispose(): void;
}

function startupElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error("Aura startup surface is missing.");
  return element;
}

function storedReducedMotion(): boolean {
  try {
    // Read the established v1 appearance flag before the workbench is loaded.
    // Startup never rewrites or migrates the user's stored workspace.
    const saved: unknown = JSON.parse(
      localStorage.getItem("aura.workspace.v1") ?? "null",
    );
    return (
      typeof saved === "object" &&
      saved !== null &&
      "reduceMotion" in saved &&
      saved.reduceMotion === true
    );
  } catch {
    return false;
  }
}

/** Leaves when the initial interface is committed; backend preparation is separate. */
export function startDesktopStartup(): DesktopStartup {
  const surface = startupElement("desktop-startup");
  const root = startupElement("root");
  const scene = startupElement("desktop-startup-scene");
  const message = startupElement("desktop-startup-message");
  const reload = startupElement("desktop-startup-reload");
  const canvas = document.getElementById("desktop-startup-field");
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let userReduced = storedReducedMotion();
  const field =
    canvas instanceof HTMLCanvasElement
      ? startStartupField(canvas, surface, media.matches || userReduced)
      : undefined;
  let state: "loading" | "leaving" | "closed" | "failed" = "loading";
  let ending: ReturnType<typeof setTimeout> | undefined;
  let movement: Animation | undefined;
  const retry = () => location.reload();
  const slow = setTimeout(() => {
    if (state !== "loading") return;
    message.textContent = "界面加载较慢，你可以继续等待或重新加载。";
    reload.hidden = false;
  }, 10_000);

  function release() {
    clearTimeout(slow);
    clearTimeout(ending);
    movement?.cancel();
    field?.dispose();
    media.removeEventListener("change", updateMotion);
    window.removeEventListener("pagehide", dispose);
  }

  function dispose() {
    release();
    reload.removeEventListener("click", retry);
    surface.remove();
    root.inert = false;
    root.removeAttribute("aria-hidden");
    state = "closed";
  }

  function updateMotion() {
    const reduced = media.matches || userReduced;
    surface.dataset.reduced = String(reduced);
    field?.setReducedMotion(reduced);
    if (reduced && state === "leaving") dispose();
  }

  media.addEventListener("change", updateMotion);
  window.addEventListener("pagehide", dispose, { once: true });
  reload.addEventListener("click", retry);
  updateMotion();

  return {
    ready(appearance) {
      // React StrictMode and later preference changes can notify repeatedly.
      if (state !== "loading") return;
      userReduced = appearance.reduced;
      updateMotion();
      clearTimeout(slow);
      root.inert = false;
      root.removeAttribute("aria-hidden");
      surface.inert = true;
      surface.setAttribute("aria-hidden", "true");
      message.textContent = "工作台已就绪";
      if (userReduced || media.matches || document.hidden) {
        dispose();
        return;
      }
      state = "leaving";
      surface.dataset.state = "leaving";
      // Dock only into a visible assistant icon; collapsed sidebars just fade.
      const icon = root.querySelector(".aura-assistant-orb");
      const target = icon?.getBoundingClientRect();
      const bounds = scene.getBoundingClientRect();
      if (target && target.width > 0 && target.height > 0) {
        const dx =
          target.left + target.width / 2 - (bounds.left + bounds.width / 2);
        const dy =
          target.top + target.height / 2 - (bounds.top + bounds.height / 2);
        movement = scene.animate(
          [
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
            {
              transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.07)`,
              opacity: 0,
            },
          ],
          {
            duration: 500,
            easing: "cubic-bezier(0.65, 0, 0.2, 1)",
            fill: "forwards",
          },
        );
      } else {
        movement = scene.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 350,
          fill: "forwards",
        });
      }
      ending = setTimeout(dispose, 520);
    },
    fail() {
      release();
      state = "failed";
      if (!surface.isConnected) document.body.append(surface);
      root.inert = true;
      root.setAttribute("aria-hidden", "true");
      surface.inert = false;
      surface.removeAttribute("aria-hidden");
      surface.dataset.state = "failed";
      surface.dataset.reduced = "true";
      message.textContent = "界面加载失败，请重新加载。";
      reload.hidden = false;
      reload.addEventListener("click", retry);
    },
    dispose,
  };
}
