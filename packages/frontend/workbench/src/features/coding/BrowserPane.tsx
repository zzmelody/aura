import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RotateCw,
} from "lucide-react";
import { browserAddress, type BrowserHost } from "@aura/protocol/browser";

/** Only the navigation methods needed by the browser toolbar. */
interface BrowserGuest extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

interface BrowserPage {
  url: string;
  back: boolean;
  forward: boolean;
}

/** The tab's last saved page, shown after a restart until the user restores it. */
export interface BrowserPageInfo {
  url: string;
  title: string;
}

const pageAddress = (url: string) => (url.startsWith("about:blank") ? "" : url);
const pageTitle = (guest: BrowserGuest) =>
  (guest.getTitle().trim() || "浏览器").slice(0, 100);

/**
 * Keep the guest attached while hidden so its page and native history survive
 * tab and conversation switches. Like DSH, a saved address is only reopened
 * when the user restores or refreshes it.
 */
export function BrowserPane({
  id,
  workspace,
  saved,
  visible,
  host,
  onPage,
}: {
  id: string;
  /** Storage group: tabs of one workspace share cookies until the app exits. */
  workspace: string;
  saved?: BrowserPageInfo;
  visible: boolean;
  host: BrowserHost;
  onPage(id: string, page: BrowserPageInfo): void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const guestRef = useRef<BrowserGuest | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  // Only the first saved page matters; later saves come from this pane itself.
  const [restore, setRestore] = useState(() =>
    saved?.url ? saved : undefined,
  );
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const [lease, setLease] = useState<string>();
  const [address, setAddress] = useState(restore?.url ?? "");
  const [page, setPage] = useState<BrowserPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const container = mount.current;
    if (!container) return;
    const tabId = id;
    let disposed = false;
    let leaseId: string | undefined;
    const release = (id: string) => {
      // The host also clears leases on renderer navigation or destruction.
      void host.release(id).catch(() => undefined);
    };
    void host
      .acquire(workspace)
      .then((reservation) => {
        if (disposed) {
          release(reservation.lease);
          return;
        }
        leaseId = reservation.lease;
        // Electron upgrades the element before firing dom-ready.
        const guest = document.createElement("webview") as BrowserGuest;
        guest.setAttribute("partition", reservation.partition);
        // The inert first page names the lease so the host can bind this guest.
        guest.setAttribute("src", `about:blank#${reservation.lease}`);
        guest.setAttribute("aria-label", "网页内容");
        const sync = () => {
          if (disposed) return;
          const address = pageAddress(guest.getURL());
          setPage({
            url: address,
            back: guest.canGoBack(),
            forward: guest.canGoForward(),
          });
          // A blank guest keeps showing the saved address until it is restored.
          if (address || !restoreRef.current) setAddress(address);
          if (address) onPage(tabId, { url: address, title: pageTitle(guest) });
        };
        guest.addEventListener("dom-ready", sync);
        guest.addEventListener("did-navigate", sync);
        guest.addEventListener("did-navigate-in-page", (event) => {
          if ((event as Event & { isMainFrame?: boolean }).isMainFrame) sync();
        });
        guest.addEventListener("page-title-updated", () => {
          const address = disposed ? "" : pageAddress(guest.getURL());
          if (address) onPage(tabId, { url: address, title: pageTitle(guest) });
        });
        guest.addEventListener("did-start-loading", () => {
          if (!disposed) {
            setError("");
            setLoading(true);
          }
        });
        guest.addEventListener("did-stop-loading", () => {
          if (!disposed) setLoading(false);
        });
        guest.addEventListener("did-fail-load", (event) => {
          const { isMainFrame, errorCode } = event as Event & {
            isMainFrame?: boolean;
            errorCode?: number;
          };
          if (!disposed && isMainFrame && errorCode !== -3)
            setError("网页加载失败，请检查地址或网络。");
        });
        guestRef.current = guest;
        container.append(guest);
        setLease(reservation.lease);
      })
      .catch(() => {
        if (!disposed) setError("无法打开浏览器，请关闭不用的标签后重试。");
      });
    return () => {
      disposed = true;
      guestRef.current?.remove();
      guestRef.current = null;
      if (leaseId) release(leaseId);
    };
  }, [host, id, workspace, onPage]);

  useEffect(() => {
    if (visible && page && !page.url && !restore) addressRef.current?.focus();
  }, [visible, page, restore]);

  const open = (value: string) => {
    if (!lease || !page) return;
    const target = browserAddress(value);
    if (!target) {
      setError("请输入有效的 HTTP 或 HTTPS 地址。");
      return;
    }
    setRestore(undefined);
    void host
      .navigate(lease, target)
      .catch(() => setError("无法打开该地址，请检查地址或网络。"));
  };
  const navigate = () => open(address);
  const reload = () => {
    if (restore) open(restore.url);
    else guestRef.current?.reload();
  };

  return (
    <section
      className="coding-browser"
      id={`tool-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`tool-tab-${id}`}
      hidden={!visible}
    >
      <form
        className="coding-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <button
          type="button"
          className="icon-control"
          aria-label="后退"
          title="后退"
          disabled={!page?.back}
          onClick={() => guestRef.current?.goBack()}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          className="icon-control"
          aria-label="前进"
          title="前进"
          disabled={!page?.forward}
          onClick={() => guestRef.current?.goForward()}
        >
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          className="icon-control"
          aria-label="刷新网页"
          title="刷新网页"
          disabled={!page || (!page.url && !restore)}
          onClick={reload}
        >
          <RotateCw size={14} />
        </button>
        <input
          ref={addressRef}
          aria-label="网页地址"
          placeholder="输入网页地址"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={!page}
        />
        <button
          type="button"
          className="icon-control"
          aria-label="在系统浏览器打开"
          title="在系统浏览器打开"
          disabled={!page?.url || !lease}
          onClick={() => {
            if (lease)
              void host
                .openExternal(lease)
                .catch(() => setError("无法打开系统浏览器。"));
          }}
        >
          <ExternalLink size={14} />
        </button>
      </form>
      {error ? (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <span className="coding-browser-loading" role="status">
          正在加载网页…
        </span>
      ) : null}
      <div className="coding-browser-content">
        <div className="coding-browser-guest" ref={mount} />
        {page && !page.url && !loading && restore ? (
          <div className="coding-browser-empty coding-browser-restore">
            <Globe size={25} />
            <strong title={restore.title}>{restore.title}</strong>
            <span title={restore.url}>{restore.url}</span>
            <button
              type="button"
              className="tool-button"
              onClick={() => open(restore.url)}
            >
              <RotateCw size={14} />
              恢复页面
            </button>
          </div>
        ) : page && !page.url && !loading ? (
          <div className="coding-browser-empty">
            <Globe size={25} />
            输入地址，按 Enter 打开网页
          </div>
        ) : null}
      </div>
    </section>
  );
}
