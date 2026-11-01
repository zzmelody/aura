import type {
  ChatModelCatalog,
  CodingConversationInfo,
  CodingProjectInfo,
  FlowMode,
} from "@aura/protocol/types";

type CacheStorage = Pick<Storage, "getItem" | "setItem">;
type Cached<T> = { endpoint: string; at: number; value: T };
type ConversationLists = Record<string, CodingConversationInfo[]>;
type Cache = {
  models: Array<Cached<ChatModelCatalog>>;
  projects: Array<Cached<CodingProjectInfo[]>>;
  conversations: Array<Cached<ConversationLists>>;
};
const key = "aura.startup-cache.v1";
const lifetime = 7 * 24 * 60 * 60 * 1_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function address(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.href.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/** Explicit projection: only public model labels/capabilities enter this cache. */
function modelCatalog(value: unknown): ChatModelCatalog | undefined {
  if (
    !isRecord(value) ||
    !["codex", "lumina", "custom", "demo"].includes(String(value.mode)) ||
    !text(value.defaultModel) ||
    !Array.isArray(value.models) ||
    value.models.length > 512
  )
    return undefined;
  const models: ChatModelCatalog["models"] = [];
  for (const model of value.models) {
    if (
      !isRecord(model) ||
      !text(model.id) ||
      !text(model.name) ||
      !Array.isArray(model.reasoningEfforts) ||
      model.reasoningEfforts.length > 32
    )
      return undefined;
    const reasoningEfforts: (typeof models)[number]["reasoningEfforts"] = [];
    for (const effort of model.reasoningEfforts) {
      if (!isRecord(effort) || !text(effort.id) || !text(effort.name))
        return undefined;
      reasoningEfforts.push({ id: effort.id, name: effort.name });
    }
    models.push({
      id: model.id,
      name: model.name,
      reasoningEfforts,
      ...(text(model.defaultReasoningEffort)
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
      ...(text(model.vendor) ? { vendor: model.vendor } : {}),
    });
  }
  return {
    mode: value.mode as FlowMode,
    defaultModel: value.defaultModel,
    models,
  };
}

function projectList(value: unknown): CodingProjectInfo[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const projects: CodingProjectInfo[] = [];
  for (const project of value) {
    if (
      !isRecord(project) ||
      !text(project.id) ||
      !text(project.title) ||
      !text(project.directory, 4_096)
    )
      return undefined;
    projects.push({
      id: project.id,
      title: project.title,
      directory: project.directory,
      ...(project.isDefault === true ? { isDefault: true } : {}),
      ...(project.status === "ok" || project.status === "missing-dir"
        ? { status: project.status }
        : {}),
    });
  }
  return projects;
}

const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Only the fields needed to paint sidebar rows; full conversations stay on the server. */
function conversationList(
  value: unknown,
  projectId: string,
): CodingConversationInfo[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined;
  const conversations: CodingConversationInfo[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !text(item.id) ||
      item.projectId !== projectId ||
      !text(item.title) ||
      !timestamp(item.createdAt) ||
      !timestamp(item.updatedAt) ||
      (item.archivedAt !== undefined && !timestamp(item.archivedAt))
    )
      return undefined;
    conversations.push({
      id: item.id,
      projectId,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(timestamp(item.archivedAt) ? { archivedAt: item.archivedAt } : {}),
    });
  }
  return conversations;
}

function conversationLists(value: unknown): ConversationLists | undefined {
  if (!isRecord(value) || Object.keys(value).length > 256) return undefined;
  const lists: Array<[string, CodingConversationInfo[]]> = [];
  for (const [projectId, items] of Object.entries(value)) {
    if (!text(projectId)) return undefined;
    const parsed = conversationList(items, projectId);
    if (!parsed) return undefined;
    lists.push([projectId, parsed]);
  }
  return Object.fromEntries(lists);
}

/** Disposable directory hints only: never credentials, transcripts, execution state or settings. */
export class StartupCache {
  private readonly storage: () => CacheStorage | undefined;
  constructor(
    storage: () => CacheStorage | undefined = () =>
      globalThis.window?.localStorage,
  ) {
    this.storage = storage;
  }

  private read(): Cache {
    const empty: Cache = { models: [], projects: [], conversations: [] };
    try {
      const saved = this.storage()?.getItem(key);
      if (!saved || saved.length > 1_000_000) return empty;
      const value: unknown = JSON.parse(saved);
      if (!isRecord(value) || value.version !== 1) return empty;
      const entries = <T>(
        raw: unknown,
        parse: (value: unknown) => T | undefined,
      ) =>
        (Array.isArray(raw) ? raw.slice(-16) : []).flatMap((entry) => {
          if (
            !isRecord(entry) ||
            !text(entry.endpoint, 2_048) ||
            address(entry.endpoint) !== entry.endpoint ||
            typeof entry.at !== "number" ||
            !Number.isFinite(entry.at) ||
            Date.now() - entry.at > lifetime ||
            entry.at > Date.now() + 60_000
          )
            return [];
          const parsed = parse(entry.value);
          return parsed === undefined
            ? []
            : [{ endpoint: entry.endpoint, at: entry.at, value: parsed }];
        });
      return {
        models: entries(value.models, modelCatalog),
        projects: entries(value.projects, projectList),
        conversations: entries(value.conversations, conversationLists),
      };
    } catch {
      return empty;
    }
  }

  private write(cache: Cache) {
    try {
      const saved = JSON.stringify({ version: 1, ...cache });
      if (saved.length <= 1_000_000) this.storage()?.setItem(key, saved);
    } catch {
      // Quota limits and private browsing must not prevent using live data.
    }
  }

  models(endpoint: string, mode: FlowMode) {
    const scope = address(endpoint);
    return this.read().models.find(
      (entry) => entry.endpoint === scope && entry.value.mode === mode,
    )?.value;
  }

  saveModels(endpoint: string, catalog: ChatModelCatalog) {
    const scope = address(endpoint);
    const value = modelCatalog(catalog);
    if (!scope || !value) return;
    const cache = this.read();
    cache.models = [
      ...cache.models.filter(
        (entry) => entry.endpoint !== scope || entry.value.mode !== value.mode,
      ),
      { endpoint: scope, at: Date.now(), value },
    ].slice(-16);
    this.write(cache);
  }

  forgetModels(endpoint: string) {
    const scope = address(endpoint);
    const cache = this.read();
    cache.models = cache.models.filter((entry) => entry.endpoint !== scope);
    this.write(cache);
  }

  projects(endpoint: string) {
    const scope = address(endpoint);
    return this.read().projects.find((entry) => entry.endpoint === scope)
      ?.value;
  }

  /** One synchronous read restores the sidebar while the runtime is still starting. */
  sidebar(endpoint: string) {
    const scope = address(endpoint);
    const cache = this.read();
    const projects =
      cache.projects.find((entry) => entry.endpoint === scope)?.value ?? [];
    const projectIds = new Set(projects.map((project) => project.id));
    const conversations = Object.fromEntries(
      Object.entries(
        cache.conversations.find((entry) => entry.endpoint === scope)?.value ??
          {},
      ).filter(([projectId]) => projectIds.has(projectId)),
    );
    return { projects, conversations };
  }

  saveConversations(
    endpoint: string,
    projectId: string,
    conversations: CodingConversationInfo[],
  ) {
    const scope = address(endpoint);
    const value = conversationList(
      Array.isArray(conversations)
        ? conversations.slice(0, 200)
        : conversations,
      projectId,
    );
    if (!scope || !text(projectId) || !value) return;
    const cache = this.read();
    const previous = cache.conversations.find(
      (entry) => entry.endpoint === scope,
    )?.value;
    if (JSON.stringify(previous?.[projectId]) === JSON.stringify(value)) return;
    cache.conversations = [
      ...cache.conversations.filter((entry) => entry.endpoint !== scope),
      {
        endpoint: scope,
        at: Date.now(),
        value: { ...previous, [projectId]: value },
      },
    ].slice(-8);
    this.write(cache);
  }

  saveProjects(endpoint: string, projects: CodingProjectInfo[]) {
    const scope = address(endpoint);
    const value = projectList(projects);
    if (!scope || !value) return;
    const cache = this.read();
    cache.projects = [
      ...cache.projects.filter((entry) => entry.endpoint !== scope),
      { endpoint: scope, at: Date.now(), value },
    ].slice(-8);
    const projectIds = new Set(value.map((project) => project.id));
    cache.conversations = cache.conversations.map((entry) =>
      entry.endpoint === scope
        ? {
            ...entry,
            value: Object.fromEntries(
              Object.entries(entry.value).filter(([projectId]) =>
                projectIds.has(projectId),
              ),
            ),
          }
        : entry,
    );
    this.write(cache);
  }
}

export const startupCache = new StartupCache();
