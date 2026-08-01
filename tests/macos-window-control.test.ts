import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { ZONE_HELPERS, buildCaptureScript, buildCloseScript, buildLaunchScript } from "../src/platform/macos/windows.ts";
import { parseLastJsonLine } from "../src/platform/macos/osascript.ts";
import { ACCESSIBILITY_MESSAGE } from "../src/platform/macos/scripts.ts";
import type { CaptureResult, CloseConfig, CloseResult, LaunchConfig, LaunchResult } from "../src/platform/types.ts";

const launch = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
	appPath: "bundle:com.tinyspeck.slackmacgap",
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
	...over,
});

const close = (over: Partial<CloseConfig> = {}): CloseConfig => ({
	appPath: "bundle:com.tinyspeck.slackmacgap",
	titleFilter: "",
	processName: "",
	closeMode: "close",
	waitSeconds: 5,
	...over,
});

/* ------------------------------- zone geometry ----------------------------- */

type ZoneRect = { x: number; y: number; width: number; height: number };
type ZoneCase = { name: string; workArea: { left: number; top: number; width: number; height: number }; zones: Record<string, ZoneRect> };

const zoneCases: ZoneCase[] = JSON.parse(readFileSync(new URL("./fixtures/zone-cases.json", import.meta.url), "utf8")).cases;

/** The JXA zone math is pure arithmetic, so it runs and is verified here. */
function jxaZoneRect(left: number, top: number, width: number, height: number, zone: string): ZoneRect {
	const sandbox = { Math, result: null as unknown };
	vm.runInNewContext(`${ZONE_HELPERS}\nresult = zoneRect(${left}, ${top}, ${width}, ${height}, ${JSON.stringify(zone)});`, sandbox);
	return JSON.parse(JSON.stringify(sandbox.result)) as ZoneRect;
}

for (const zoneCase of zoneCases) {
	test(`macOS zone geometry matches the shared contract: ${zoneCase.name}`, () => {
		const { left, top, width, height } = zoneCase.workArea;
		for (const [zone, expected] of Object.entries(zoneCase.zones)) {
			assert.deepEqual(jxaZoneRect(left, top, width, height, zone), expected, `${zoneCase.name} / ${zone}`);
		}
	});

	test(`zones tile the work area exactly: ${zoneCase.name}`, () => {
		const { left, top, width, height } = zoneCase.workArea;
		const l = jxaZoneRect(left, top, width, height, "left");
		const r = jxaZoneRect(left, top, width, height, "right");
		assert.equal(l.width + r.width, width, "halves cover the full width with no gap or overlap");
		assert.equal(l.x, left);
		assert.equal(r.x + r.width, left + width, "the right half reaches the work-area edge");

		const t = jxaZoneRect(left, top, width, height, "top");
		const b = jxaZoneRect(left, top, width, height, "bottom");
		assert.equal(t.height + b.height, height, "halves cover the full height");
		assert.equal(b.y + b.height, top + height, "the bottom half reaches the work-area edge");
	});
}

test("an unknown zone falls back to filling the work area", () => {
	assert.deepEqual(jxaZoneRect(0, 0, 1920, 1040, "nonsense"), { x: 0, y: 0, width: 1920, height: 1040 });
});

/* ----------------------------- monitor resolution -------------------------- */

type FakeMonitor = { deviceName: string; isPrimary: boolean };

function jxaResolveMonitor(monitors: FakeMonitor[], monitorId: string): FakeMonitor | null {
	const sandbox = { Math, result: null as unknown, monitors };
	vm.runInNewContext(`${ZONE_HELPERS}\nresult = resolveTargetMonitor(monitors, ${JSON.stringify(monitorId)});`, sandbox);
	return sandbox.result === null ? null : (JSON.parse(JSON.stringify(sandbox.result)) as FakeMonitor);
}

const displays: FakeMonitor[] = [
	{ deviceName: "69733382", isPrimary: true },
	{ deviceName: "724043442", isPrimary: false },
];

test("a saved display is matched by its opaque id", () => {
	assert.equal(jxaResolveMonitor(displays, "724043442")?.deviceName, "724043442");
});

test("the primary sentinel resolves to the primary display", () => {
	assert.equal(jxaResolveMonitor(displays, "primary")?.deviceName, "69733382");
});

test("a disconnected display falls back to the primary", () => {
	assert.equal(jxaResolveMonitor(displays, "999999")?.deviceName, "69733382", "a missing display must not fail the press");
});

test("with no displays at all there is nothing to resolve", () => {
	assert.equal(jxaResolveMonitor([], "primary"), null);
});

/* --------------------------- script well-formedness ------------------------ */

const allScripts: [string, string][] = [
	["launch (zone)", buildLaunchScript(launch())],
	["launch (custom rect)", buildLaunchScript(launch({ positionMode: "custom", x: 10, y: 20, width: 800, height: 600 }))],
	["launch (no positioning)", buildLaunchScript(launch({ positionMode: "none" }))],
	["launch (with args and filter)", buildLaunchScript(launch({ launchArgs: "--profile work", titleFilter: "Inbox" }))],
	["capture", buildCaptureScript(launch())],
	["close (graceful)", buildCloseScript(close())],
	["close (closeThenKill)", buildCloseScript(close({ closeMode: "closeThenKill" }))],
	["close (kill)", buildCloseScript(close({ closeMode: "kill" }))],
];

for (const [name, script] of allScripts) {
	test(`the ${name} script is syntactically valid JavaScript`, () => {
		assert.doesNotThrow(() => new vm.Script(script));
	});
}

test("every window-control script gates on Accessibility before touching System Events", () => {
	for (const [name, script] of allScripts) {
		assert.ok(script.includes("assertTrusted();"), `${name} must check the permission`);
		const gate = script.indexOf("assertTrusted();");
		const firstUse = script.indexOf("systemEvents()", script.indexOf("(function () {"));
		assert.ok(gate > 0, `${name} calls the gate`);
		if (firstUse !== -1) {
			assert.ok(script.includes("function systemEvents()"), `${name} reaches System Events only through the helper`);
		}
	}
});

test("the target application is never scripted directly", () => {
	for (const [name, script] of allScripts) {
		// Application(...) is only ever System Events; anything else would raise
		// a per-app "wants to control" prompt for every app a user configures.
		const calls = script.match(/Application\((.*?)\)/g) ?? [];
		for (const call of calls) {
			assert.match(call, /'System Events'/, `${name} may only script System Events, found: ${call}`);
		}
	}
});

test("launching goes through /usr/bin/open, not an Apple Event", () => {
	const script = buildLaunchScript(launch());
	assert.ok(script.includes("runTool('/usr/bin/open'"), "the launcher shells out to open");
	assert.ok(!script.includes(".activate()"), "the target app's own activate must never be called");
});

test("force-quitting uses NSRunningApplication, not the app's quit event", () => {
	const script = buildCloseScript(close({ closeMode: "kill" }));
	assert.ok(script.includes("forceTerminate"));
	// ObjC zero-argument methods are properties in JXA; calling one would invoke
	// the value it returned and throw.
	assert.ok(!script.includes("forceTerminate()"), "must not be called as a function");
	assert.ok(!script.includes(".quit()"), "the app's quit Apple Event must never be sent");
});

test("graceful close presses the window's own close button", () => {
	const script = buildCloseScript(close());
	assert.ok(script.includes("AXCloseButton"), "equivalent to clicking the red button, so save prompts still appear");
	assert.ok(script.includes("AXPress"));
});

test("the config is embedded and reachable by the script", () => {
	const script = buildLaunchScript(launch({ titleFilter: "Inbox", waitSeconds: 42 }));
	assert.ok(script.includes("var CFG = {"), "the config is embedded as a literal");
	assert.ok(script.includes('"titleFilter":"Inbox"'));
	assert.ok(script.includes('"waitSeconds":42'));
});

test("a virtual desktop carried over from Windows is ignored, not honoured", () => {
	const script = buildLaunchScript(launch({ virtualDesktop: "Work" }));
	// The value rides along inside CFG but nothing ever reads it.
	assert.ok(script.includes('"virtualDesktop":"Work"'), "the setting is preserved in the config");
	assert.ok(!script.includes("CFG.virtualDesktop"), "and is never acted on");
	assert.ok(script.includes("movedDesktop: false"), "the result reports no desktop move");
});

test("positioning does not compensate for invisible borders", () => {
	// That compensation is a Win32 concern: the AX frame is the visible frame.
	const script = buildLaunchScript(launch());
	assert.ok(!script.includes("ExtendedFrameBounds") && !script.includes("DwmGetWindowAttribute"));
});

test("a minimized window is restored before a rectangle is applied", () => {
	const script = buildLaunchScript(launch());
	const restore = script.indexOf("setAttrValue(win, 'AXMinimized', false)");
	const move = script.indexOf("win.position = [rect.x, rect.y]");
	assert.ok(restore !== -1 && move !== -1);
	assert.ok(restore < move, "the window is un-minimized first");
});

/* ------------------------------ result parsing ----------------------------- */

test("a successful launch result parses into the shared shape", () => {
	const parsed = parseLastJsonLine<LaunchResult>(
		'{"ok":true,"launched":true,"positioned":true,"movedDesktop":false,"pid":501,"title":"general — Slack"}',
	);
	assert.equal(parsed.ok, true);
	const value = parsed.ok ? parsed.value : null;
	assert.equal(value?.ok, true);
	assert.equal(value?.ok === true && value.launched, true);
	assert.equal(value?.ok === true && value.pid, 501);
	assert.equal(value?.ok === true && value.movedDesktop, false);
});

test("a focus-without-launch result reports launched: false", () => {
	const parsed = parseLastJsonLine<LaunchResult>(
		'{"ok":true,"launched":false,"positioned":true,"movedDesktop":false,"pid":501,"title":"Slack"}',
	);
	assert.equal(parsed.ok && parsed.value.ok === true && parsed.value.launched, false);
});

test("a permission failure parses into the failure shape", () => {
	const parsed = parseLastJsonLine<LaunchResult>(JSON.stringify({ ok: false, error: ACCESSIBILITY_MESSAGE }));
	assert.equal(parsed.ok && parsed.value.ok, false);
	assert.equal(parsed.ok && parsed.value.ok === false && parsed.value.error, ACCESSIBILITY_MESSAGE);
});

test("a not-found failure parses into the failure shape", () => {
	const message = 'Could not find the application for "bundle:com.example.gone". Re-pick the app in the key settings.';
	const parsed = parseLastJsonLine<LaunchResult>(JSON.stringify({ ok: false, error: message }));
	assert.equal(parsed.ok && parsed.value.ok === false && parsed.value.error, message);
});

test("a capture result parses into the shared shape", () => {
	const parsed = parseLastJsonLine<CaptureResult>(
		'{"ok":true,"x":100,"y":37,"width":1200,"height":800,"title":"Inbox","maximized":false}',
	);
	assert.equal(parsed.ok && parsed.value.ok === true && parsed.value.width, 1200);
	assert.equal(parsed.ok && parsed.value.ok === true && parsed.value.y, 37);
});

test("a close result reports found, closed and killed", () => {
	const parsed = parseLastJsonLine<CloseResult>('{"ok":true,"found":3,"closed":3,"killed":1}');
	assert.equal(parsed.ok && parsed.value.ok === true && parsed.value.found, 3);
	assert.equal(parsed.ok && parsed.value.ok === true && parsed.value.killed, 1);
});

test("closing nothing is a success, not an error", () => {
	const parsed = parseLastJsonLine<CloseResult>('{"ok":true,"found":0,"closed":0,"killed":0}');
	assert.equal(parsed.ok && parsed.value.ok, true);
	assert.equal(parsed.ok && parsed.value.ok === true && parsed.value.found, 0);
});
