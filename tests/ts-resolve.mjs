/**
 * Test-only module resolution shim.
 *
 * `src/` is written for a bundler: relative imports omit the extension
 * ("./powershell") and may name a directory ("./windows"), both of which
 * Rollup resolves. Node's ESM resolver does neither, so importing a src module
 * that has value imports fails under `node --test`.
 *
 * This hook restores the bundler behavior for relative specifiers only: if the
 * literal specifier does not resolve, retry it as `<spec>.ts` and then as
 * `<spec>/index.ts`. Bare package specifiers are left entirely alone.
 *
 * Registered via `node --import ./tests/ts-resolve.mjs` in the test script.
 */
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			return nextResolve(specifier, context);
		}

		try {
			return nextResolve(specifier, context);
		} catch (error) {
			for (const candidate of [`${specifier}.ts`, `${specifier.replace(/\/$/, "")}/index.ts`]) {
				try {
					return nextResolve(candidate, context);
				} catch {
					// try the next shape; the original error is thrown if none work
				}
			}
			throw error;
		}
	},
});
