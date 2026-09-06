import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs", "vitest.config.mts", "test/standards/*.test.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    ignores: [
      ".dev-server/",
      ".vscode/",
      "*.test.js",
      // The ioBroker template files under test/ (integration.js, package.js, inventory.js)
      // are shipped as-is and stay out; test/standards/ is our own vitest suite and is
      // linted like every other suite (fleet rule since 2026-09-02).
      "test/*.js",
      "test/fixtures/**",
      "*.config.mjs",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
