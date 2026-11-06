import type {
  FlowCatalog,
  AuraPluginSettingsState,
} from "@aura/protocol/types";
import type {
  PluginLocalization,
  MetadataCatalogs,
} from "@aura/protocol/localization";
const locales = ["zh-CN", "en", "ja", "ko", "ru", "fr"] as const;
const words = {
  name: [
    "示例工具",
    "Example tools",
    "サンプルツール",
    "예제 도구",
    "Пример инструментов",
    "Outils d’exemple",
  ],
  title: [
    "生成报告",
    "Create a report",
    "レポートを作成",
    "보고서 생성",
    "Создать отчёт",
    "Créer un rapport",
  ],
  description: [
    "检查资料并生成报告。",
    "Inspect material and create a report.",
    "資料を確認してレポートを作成します。",
    "자료를 검토하고 보고서를 생성합니다.",
    "Проверьте материалы и создайте отчёт.",
    "Analysez les données et créez un rapport.",
  ],
  prompt: [
    "报告内容",
    "Report content",
    "レポートの内容",
    "보고서 내용",
    "Содержание отчёта",
    "Contenu du rapport",
  ],
  hint: [
    "描述需要的内容",
    "Describe the content you need",
    "必要な内容を説明してください",
    "필요한 내용을 설명하세요",
    "Опишите нужное содержание",
    "Décrivez le contenu souhaité",
  ],
  mode: ["格式", "Format", "形式", "형식", "Формат", "Format de sortie"],
  short: ["简洁", "Concise", "簡潔", "간결", "Кратко", "Concis"],
  full: ["完整", "Complete", "完全", "전체", "Полностью", "Complet"],
  count: [
    "条目数",
    "Item count",
    "項目数",
    "항목 수",
    "Количество записей",
    "Nombre d’éléments",
  ],
};
export const metadata: PluginLocalization = {
  catalogs: Object.fromEntries(
    locales.map((locale, index) => [
      locale,
      Object.fromEntries(
        Object.entries(words).map(([key, values]) => [key, values[index]]),
      ),
    ]),
  ) as MetadataCatalogs,
  nameKey: "name",
  descriptionKey: "description",
  flows: {
    report: {
      titleKey: "title",
      descriptionKey: "description",
      input: {
        "/properties/prompt": { titleKey: "prompt", placeholderKey: "hint" },
        "/properties/mode": { titleKey: "mode", enumKeys: ["short", "full"] },
        "/properties/tags": { titleKey: "mode", descriptionKey: "hint" },
        "/properties/tags/items": { enumKeys: ["short", "full"] },
        "/properties/a~1b~0c": { titleKey: "prompt" },
        "/properties/imageAssetId": {
          titleKey: "prompt",
          placeholderKey: "hint",
        },
      },
      output: { "/items/properties/count": { titleKey: "count" } },
    },
  },
  actions: { read: { titleKey: "title", descriptionKey: "description" } },
};
const identity = {
  id: "example.tools",
  name: "Original plugin",
  version: "1.0.0",
};
export const catalog: FlowCatalog = {
  plugins: [
    { ...identity, enabled: true, available: true, localization: metadata },
  ],
  flows: [
    {
      id: "example.tools/report",
      title: "Original flow",
      description: "Original description",
      available: true,
      plugin: identity,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            title: "Original prompt",
            description: "Original hint",
          },
          mode: { type: "string", enum: ["brief", "full"], default: "brief" },
          tags: {
            type: "array",
            items: { type: "string", enum: ["brief", "full"] },
          },
          "a/b~c": { type: "string", description: "选择图片路径" },
          imageAssetId: { type: "string" },
        },
        required: ["prompt"],
      },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          properties: { count: { type: "number", title: "Original count" } },
        },
      },
    },
  ],
  actions: [
    {
      id: "example.tools/read",
      title: "Original action",
      description: "Original action description",
      available: true,
      plugin: identity,
    },
  ],
  presets: [],
};
export const settings: AuraPluginSettingsState = {
  configPath: "/synthetic/plugins.json",
  active: catalog.plugins!,
  applyRequired: false,
  plugins: [
    {
      path: "/synthetic/example",
      enabled: true,
      trust: "local",
      builtin: false,
      status: catalog.plugins![0],
    },
  ],
};
