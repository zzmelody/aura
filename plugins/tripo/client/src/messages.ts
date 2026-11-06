import {
  usePluginTranslation,
  type TranslationCatalogs,
} from '@aura/plugin-ui';
import zh from './locales/zh-CN.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import ko from './locales/ko.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };

export const translations = {
  'zh-CN': zh,
  en,
  ja,
  ko,
  ru,
  fr,
} satisfies TranslationCatalogs;

export function useTripoMessages() {
  return usePluginTranslation('aura.tripo');
}
