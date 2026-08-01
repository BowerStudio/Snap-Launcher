import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { isTimeout, parseLastJsonLine, timeoutMessage } from "../src/platform/macos/osascript.ts";
import { ACCESSIBILITY_MESSAGE, jsConfig, jsLiteral, PROLOG, wrapScript } from "../src/platform/macos/scripts.ts";
import type { LaunchConfig } from "../src/platform/types.ts";

const launchConfig: LaunchConfig = {
	appPath: "/Applications/Slack.app",
	launchArgs: "",
	titleFilter: "",
	processName: "",
	focusIfRunning: true,
	positionMode: "zone",
	monitorId: "primary",
	zone: "left",
	waitSeconds: 10,
	x: 0,
	y: 0,
	width: 0,
	height: 0,
	virtualDesktop: "",
};

/* ------------------------------ output parsing ----------------------------- */

test("parseLastJsonLine takes the last line that actually parses", () => {
	const stdout = '{"ok":true,"stale":1}\n{"ok":true,"launched":true}';
	const parsed = parseLastJsonLine<{ ok: boolean; launched: boolean }>(stdout);
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.ok && parsed.value, { ok: true, launched: true });
});

test("parseLastJsonLine skips trailing OS noise", () => {
	// osascript is happy to emit deprecation warnings after the result.
	const stdout = '{"ok":true,"found":2,"closed":2,"killed":0}\nsome deprecation notice\n';
	const parsed = parseLastJsonLine<{ found: number }>(stdout);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.ok && parsed.value.found, 2);
});

test("parseLastJsonLine skips a JSON-looking line that does not parse", () => {
	const stdout = '{"ok":true,"good":1}\n{ this is not json\n';
	const parsed = parseLastJsonLine<{ good: number }>(stdout);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.ok && parsed.value.good, 1);
});

test("parseLastJsonLine parses a top-level array", () => {
	const parsed = parseLastJsonLine<unknown[]>('[{"name":"Slack"}]');
	assert.equal(parsed.ok, true);
	assert.equal(parsed.ok && parsed.value.length, 1);
});

test("parseLastJsonLine reports the last line when nothing parses", () => {
	const parsed = parseLastJsonLine("execution error: Something went wrong (-1743)");
	assert.equal(parsed.ok, false);
	assert.equal(parsed.ok === false && parsed.lastLine, "execution error: Something went wrong (-1743)");
});

test("parseLastJsonLine handles empty output", () => {
	const parsed = parseLastJsonLine("   \n\n");
	assert.equal(parsed.ok, false);
	assert.equal(parsed.ok === false && parsed.lastLine, "");
});

test("a failure result parses into the shared failure shape", () => {
	const parsed = parseLastJsonLine<{ ok: false; error: string }>(`{"ok":false,"error":${JSON.stringify(ACCESSIBILITY_MESSAGE)}}`);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.ok && parsed.value.ok, false);
	assert.equal(parsed.ok && parsed.value.error, ACCESSIBILITY_MESSAGE);
});

/* --------------------------------- timeouts -------------------------------- */

test("isTimeout recognises how execFile reports a timeout", () => {
	assert.equal(isTimeout(Object.assign(new Error("killed"), { killed: true })), true);
	assert.equal(isTimeout(Object.assign(new Error("sigterm"), { signal: "SIGTERM" })), true);
	assert.equal(isTimeout(Object.assign(new Error("exit 1"), { killed: false, signal: null })), false);
	assert.equal(isTimeout(null), false);
});

test("the timeout message identifies itself as a timeout in whole seconds", () => {
	assert.equal(timeoutMessage(30_000), "The operation timed out after 30s.");
	assert.match(timeoutMessage(20_000), /timed out/);
});

/* ------------------------------ config embedding --------------------------- */

test("jsLiteral round-trips quotes, backslashes and non-ASCII titles", () => {
	const nasty = `He said "hi" \\ back\\slash — 日本語 emoji 🎛️ 'single'`;
	const evaluated = vm.runInNewContext(`(${jsLiteral(nasty)})`);
	assert.equal(evaluated, nasty);
});

test("jsLiteral escapes the line/paragraph separators that would break the script", () => {
	const withSeparators = `before${String.fromCharCode(0x2028)}after${String.fromCharCode(0x2029)}end`;
	const literal = jsLiteral(withSeparators);
	assert.ok(!literal.includes(String.fromCharCode(0x2028)), "no raw U+2028 survives into the script");
	assert.ok(!literal.includes(String.fromCharCode(0x2029)), "no raw U+2029 survives into the script");
	assert.equal(vm.runInNewContext(`(${literal})`), withSeparators);
});

/** Objects built inside a vm context are cross-realm; compare by value. */
function evalConfig(config: LaunchConfig): unknown {
	const context: Record<string, unknown> = {};
	vm.runInNewContext(jsConfig(config), context);
	return JSON.parse(JSON.stringify(context.CFG));
}

test("jsConfig produces an assignment that evaluates back to the config", () => {
	assert.deepEqual(evalConfig(launchConfig), launchConfig);
});

test("a title filter cannot break out of the embedded config", () => {
	const hostile: LaunchConfig = { ...launchConfig, titleFilter: `"; throw new Error('escaped'); var x = "` };
	assert.deepEqual(evalConfig(hostile), hostile);
});

/* --------------------------- script well-formedness ------------------------- */

/**
 * osascript cannot run here, so the next best guarantee is that everything the
 * builders emit is at least syntactically valid JavaScript. This is what
 * catches the likes of a raw U+2028 inside a regex literal.
 */
function assertParses(source: string, what: string): void {
	assert.doesNotThrow(() => new vm.Script(source), `${what} must be syntactically valid JavaScript`);
}

test("the prolog is syntactically valid JavaScript", () => {
	assertParses(PROLOG, "the prolog");
});

test("wrapScript emits a valid script that returns one JSON string", () => {
	const script = wrapScript(`return { ok: true, launched: false };`);
	assertParses(script, "a wrapped script");
	assert.ok(script.includes("JSON.stringify"), "the result is serialised");
	assert.ok(script.includes("catch"), "a thrown error still produces output");
});

test("the accessibility message names the permission and where to grant it", () => {
	assert.match(ACCESSIBILITY_MESSAGE, /Accessibility/);
	assert.match(ACCESSIBILITY_MESSAGE, /System Settings/);
	assert.match(ACCESSIBILITY_MESSAGE, /Privacy & Security/);
});

test("the prolog never prompts for accessibility", () => {
	// AXIsProcessTrustedWithOptions is the prompting variant. The prolog's
	// comments name it to explain the choice, so only a real call counts.
	assert.ok(!PROLOG.includes("$.AXIsProcessTrustedWithOptions"), "the prompting API must never be called");
	assert.ok(PROLOG.includes("$.AXIsProcessTrusted()"), "the non-prompting check is used");
});
