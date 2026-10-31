import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFiles = [
  "apps/**/*.{ts,tsx,js}",
  "packages/**/*.{ts,tsx,js}",
  "scripts/**/*.ts",
  "tests/**/*.ts",
  "eslint.config.ts",
];

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/dist-host/**",
    "apps/mobile/android/**",
    "apps/mobile/ios/**",
    ".aura/**",
    ".tools/**",
    "output/**",
  ]),
  {
    name: "aura/source",
    files: sourceFiles,
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    extends: [js.configs.recommended, tseslint.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Google TypeScript conventions; formatting belongs to Prettier.
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "one-var": ["error", "never"],
      "new-cap": [
        "error",
        {
          // DSH exports branded ID factories with their public type names.
          capIsNewExceptions: [
            "MessageId",
            "SessionId",
            "ToolCallId",
            "ReasoningEffortId",
            "ScheduleId",
          ],
        },
      ],
      "guard-for-in": "error",
      "no-new-wrappers": "error",
      "@typescript-eslint/no-array-constructor": "error",
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "typeLike", format: ["PascalCase"] },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },
  {
    name: "aura/library-exports",
    files: ["packages/*/*/src/**/*.{ts,tsx}"],
    // The workbench root is a React host entrypoint shared by all apps.
    ignores: ["packages/frontend/workbench/src/App.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Use named exports for reusable Aura library modules.",
        },
        {
          selector:
            "ExportNamedDeclaration > VariableDeclaration[kind!='const']",
          message: "Export a getter instead of a mutable module binding.",
        },
      ],
    },
  },
  {
    name: "aura/node",
    files: ["packages/backend/**/*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    name: "aura/react-hooks",
    files: ["packages/frontend/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"],
    // The plugin's nested legacy/flat configs are not ESLint 10 config objects.
    plugins: {
      "react-hooks": { meta: reactHooks.meta, rules: reactHooks.rules },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
