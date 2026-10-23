import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Airbnb-derived quality rules plus Aura SDK/TypeScript/React adaptations.
// This is an explicit subset, not the incompatible ESLint 8 Airbnb preset.
export default defineConfig(
  globalIgnores(["**/node_modules/**", "**/dist/**", "**/runtime/**"]),
  {
    files: ["**/*.{ts,tsx,js}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-param-reassign": ["error", { props: false }],
      "no-eval": "error",
      "no-new-func": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    files: ["**/*.js"],
    rules: { curly: ["error", "all"], "no-nested-ternary": "error" },
  },
  {
    files: ["**/client/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": { meta: reactHooks.meta, rules: reactHooks.rules },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
