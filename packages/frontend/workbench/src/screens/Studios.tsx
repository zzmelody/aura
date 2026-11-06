import React from "react";
import { ChevronRight, PlugZap } from "lucide-react";
import type { PluginStudio } from "../usePluginPages";
import type { Tab } from "../types";
import { studioIcon } from "../studioIcons";
import { useSidebarMessages } from "../sidebar-messages.ts";
import "./studios.css";

/**
 * Tile home for every plugin-contributed page. The sidebar keeps one entry for
 * the workbench; the pages themselves live here instead of flattening into the
 * navigation list. A page's description is its own to declare, so tiles hold a
 * fixed height rather than inventing supporting text for pages without one.
 */
export function StudiosScreen({
  studios,
  failures,
  navigate,
  onManagePlugins,
}: {
  studios: readonly PluginStudio[];
  failures: ReadonlyArray<{ id: string; message: string }>;
  navigate(tab: Tab): void;
  onManagePlugins(): void;
}) {
  const { t } = useSidebarMessages();
  return (
    <section className="dsh-page studios-page" aria-labelledby="studios-title">
      <header className="dsh-page-head">
        <div>
          <h1 id="studios-title">{t("studios")}</h1>
          <p>{t("studiosHint")}</p>
        </div>
        <div className="dsh-page-actions">
          <button
            type="button"
            className="dsh-button"
            onClick={onManagePlugins}
          >
            <PlugZap size={13} />
            {t("managePlugins")}
          </button>
        </div>
      </header>
      {failures.length ? (
        <p className="dsh-page-notice" role="alert">
          {failures[0].message}
        </p>
      ) : null}
      {studios.length ? (
        <ul className="studios-grid">
          {studios.map((studio) => {
            const Icon = studioIcon(studio.page.definition.icon);
            return (
              <li key={studio.id}>
                <button
                  type="button"
                  className="studios-tile"
                  onClick={() => navigate(studio.id)}
                >
                  <span className="studios-tile-head">
                    <Icon
                      size={26}
                      className="studios-tile-icon"
                      aria-hidden="true"
                    />
                    <ChevronRight
                      size={16}
                      className="studios-tile-go"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="studios-tile-copy">
                    <strong>{studio.title}</strong>
                    {studio.description ? (
                      <span>{studio.description}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : failures.length ? null : (
        <p className="dsh-page-empty">{t("noStudios")}</p>
      )}
    </section>
  );
}
