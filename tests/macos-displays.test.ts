import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { buildDisplayListScript, toMonitorEntries, type RawScreen } from "../src/platform/macos/displays.ts";
import { toMonitorItems } from "../src/monitors.ts";

/* --------------------------- NSScreen test double -------------------------- */

type Frame = { origin: { x: number; y: number }; size: { width: number; height: number } };

const frame = (x: number, y: number, width: number, height: number): Frame => ({ origin: { x, y }, size: { width, height } });

function makeScreen(f: Frame, visible: Frame, screenNumber: string): unknown {
	return {
		frame: f,
		visibleFrame: visible,
		deviceDescription: {
			objectForKey: (key: string) =>
				key === "NSScreenNumber" ? { isNil: () => false, stringValue: screenNumber } : { isNil: () => true },
		},
	};
}

/**
 * Runs the real display script against a fake AppKit. osascript cannot run
 * here, but the coordinate conversion is the part most likely to be wrong and
 * it is pure arithmetic over NSScreen — so it is exercised directly rather
 * than trusted.
 */
function runDisplayScript(screens: unknown[]): RawScreen[] {
	const sandbox = {
		ObjC: {
			import: () => undefined,
			unwrap: (v: unknown) => v,
		},
		$: {
			NSScreen: {
				screens: {
					count: screens.length,
					objectAtIndex: (i: number) => screens[i],
				},
			},
		},
		JSON,
		Math,
		String,
		Error,
	};

	const output = vm.runInNewContext(buildDisplayListScript(), sandbox) as string;
	return JSON.parse(output) as RawScreen[];
}

/*
 * A real two-display arrangement in NSScreen's bottom-left space:
 *
 *   built-in : frame (0,0) 1512x982, visible (0,32) 1512x913
 *              -> 37pt menu bar at the top, 32pt Dock at the bottom
 *   external : frame (-2560,982) 2560x1440 — up and to the left of the primary
 */
const builtIn = makeScreen(frame(0, 0, 1512, 982), frame(0, 32, 1512, 913), "69733382");
const external = makeScreen(frame(-2560, 982, 2560, 1440), frame(-2560, 982, 2560, 1415), "724043442");

test("the primary display anchors the top-left origin space", () => {
	const [primary] = runDisplayScript([builtIn]);

	assert.equal(primary.left, 0);
	assert.equal(primary.top, 0, "the primary display's top-left is the origin");
	assert.equal(primary.width, 1512);
	assert.equal(primary.height, 982);
	assert.equal(primary.isPrimary, true);
	assert.equal(primary.deviceName, "69733382", "the CGDirectDisplayID is carried through as an opaque key");
});

test("the work area excludes the menu bar and the Dock", () => {
	const [primary] = runDisplayScript([builtIn]);

	// visibleFrame (0,32) 1512x913 flips to a 37pt inset at the top.
	assert.equal(primary.workLeft, 0);
	assert.equal(primary.workTop, 37, "the menu bar is excluded from the top");
	assert.equal(primary.workWidth, 1512);
	assert.equal(primary.workHeight, 913, "the Dock is excluded from the bottom");
	assert.ok(primary.workHeight < primary.height, "the work area is smaller than the display");
});

test("a display above and left of the primary reports negative coordinates", () => {
	const [, second] = runDisplayScript([builtIn, external]);

	assert.equal(second.left, -2560, "left of the primary is negative x");
	assert.equal(second.top, -1440, "above the primary is negative y");
	assert.equal(second.width, 2560);
	assert.equal(second.height, 1440);
	assert.equal(second.isPrimary, false);
	assert.equal(second.workTop, -1415);
});

test("exactly one display is primary", () => {
	const screens = runDisplayScript([builtIn, external]);
	assert.equal(screens.length, 2);
	assert.equal(screens.filter((s) => s.isPrimary).length, 1);
});

test("no displays yields an empty list rather than an error", () => {
	assert.deepEqual(runDisplayScript([]), []);
});

/* ------------------------------ index assignment --------------------------- */

const raw = (over: Partial<RawScreen>): RawScreen => ({
	deviceName: "1",
	left: 0,
	top: 0,
	width: 1920,
	height: 1080,
	workLeft: 0,
	workTop: 0,
	workWidth: 1920,
	workHeight: 1040,
	isPrimary: false,
	...over,
});

test("toMonitorEntries numbers displays from 1 with the primary first", () => {
	const entries = toMonitorEntries([
		raw({ deviceName: "724043442" }),
		raw({ deviceName: "69733382", isPrimary: true }),
	]);

	assert.deepEqual(
		entries.map((e) => [e.deviceName, e.index, e.isPrimary]),
		[
			["69733382", 1, true],
			["724043442", 2, false],
		],
	);
});

test("toMonitorEntries survives a malformed response", () => {
	assert.deepEqual(toMonitorEntries(undefined as unknown as RawScreen[]), []);
});

/* ------------------------- labelling in the inspector ---------------------- */

test("macOS displays label and sort correctly in the Property Inspector", () => {
	const screens = runDisplayScript([builtIn, external]);
	const items = toMonitorItems(toMonitorEntries(screens));

	assert.deepEqual(
		items.map((i) => i.label),
		["Monitor 1 — 1512×982 (primary)", "Monitor 2 — 2560×1440"],
	);
	// The persisted value stays the opaque display id, never the label.
	assert.deepEqual(
		items.map((i) => i.value),
		["69733382", "724043442"],
	);
	// Geometry passes through so the PI can draw the arrangement to scale.
	assert.deepEqual(
		items.map((i) => [i.left, i.top]),
		[
			[0, 0],
			[-2560, -1440],
		],
	);
});
