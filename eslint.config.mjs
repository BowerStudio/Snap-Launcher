import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"node_modules/",
			"com.bowerstudio.snap-launcher.sdPlugin/bin/",
			"com.bowerstudio.snap-launcher.sdPlugin/logs/",
			"marketplace_assets/",
			"logs/",
		],
	},

	js.configs.recommended,

	// Type-aware linting is deliberately off: tests/ is not in tsconfig's `include`,
	// and the src/tests split on import extensions makes a shared project awkward.
	...tseslint.configs.recommended,

	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		languageOptions: {
			globals: globals.node,
		},
	},

	// Property Inspector scripts are vanilla browser ESM, not part of the bundle.
	{
		files: ["com.bowerstudio.snap-launcher.sdPlugin/ui/**/*.js"],
		languageOptions: {
			globals: globals.browser,
		},
	},

	// Build/tooling scripts: rollup.config.mjs, bump-version.mjs, tests/ts-resolve.mjs,
	// .claude/hooks/*.mjs. All run under Node.
	{
		files: ["**/*.mjs"],
		languageOptions: {
			globals: globals.node,
		},
	},

	{
		rules: {
			// The plugin talks to JSON emitted by PowerShell/osascript; `any` at those
			// boundaries is intentional and narrowed by hand.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},

	prettier,
);
