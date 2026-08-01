import assert from "node:assert/strict";
import { test } from "node:test";

import { toMonitorItems } from "../src/monitors.ts";
import type { MonitorEntry } from "../src/platform/types.ts";

const mon = (over: Partial<MonitorEntry>): MonitorEntry => ({
	deviceName: "\\\\.\\DISPLAY1",
	index: 1,
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

test("toMonitorItems sorts by arrangement index and labels each monitor", () => {
	const items = toMonitorItems([
		mon({ deviceName: "\\\\.\\DISPLAY2", index: 2, isPrimary: true }),
		mon({ deviceName: "\\\\.\\DISPLAY1", index: 1, width: 2560, height: 1440 }),
	]);
	assert.equal(items.length, 2);
	assert.equal(items[0].value, "\\\\.\\DISPLAY1");
	assert.equal(items[0].label, "Monitor 1 — 2560×1440");
	assert.equal(items[1].value, "\\\\.\\DISPLAY2");
	assert.equal(items[1].label, "Monitor 2 — 1920×1080 (primary)");
});

test("toMonitorItems passes geometry through unchanged", () => {
	const items = toMonitorItems([mon({ deviceName: "\\\\.\\DISPLAY1", left: -1280, top: 200, width: 1280, height: 1024, isPrimary: true })]);
	assert.deepEqual(
		{ left: items[0].left, top: items[0].top, width: items[0].width, height: items[0].height, isPrimary: items[0].isPrimary },
		{ left: -1280, top: 200, width: 1280, height: 1024, isPrimary: true },
	);
});

/**
 * macOS display ids are opaque CGDirectDisplayID numbers, so a label derived
 * from the identifier would read "Monitor 724043442". The index carries the
 * arrangement position instead, and the opaque id stays the persisted value.
 */
test("toMonitorItems labels opaque (macOS) display ids from the index", () => {
	const items = toMonitorItems([
		mon({ deviceName: "724043442", index: 2, width: 2560, height: 1440 }),
		mon({ deviceName: "69733382", index: 1, width: 1512, height: 982, isPrimary: true }),
	]);
	assert.equal(items[0].value, "69733382");
	assert.equal(items[0].label, "Monitor 1 — 1512×982 (primary)");
	assert.equal(items[1].value, "724043442");
	assert.equal(items[1].label, "Monitor 2 — 2560×1440");
});
