import assert from "node:assert/strict";
import { test } from "node:test";

import { layoutMonitors, zoneFromPoint, zoneRect } from "../com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js";

test("zoneFromPoint maps centre, edges, and corners", () => {
	assert.equal(zoneFromPoint(0.5, 0.5), "full");
	assert.equal(zoneFromPoint(0.1, 0.5), "left");
	assert.equal(zoneFromPoint(0.9, 0.5), "right");
	assert.equal(zoneFromPoint(0.5, 0.1), "top");
	assert.equal(zoneFromPoint(0.5, 0.9), "bottom");
	assert.equal(zoneFromPoint(0.1, 0.1), "topLeft");
	assert.equal(zoneFromPoint(0.9, 0.1), "topRight");
	assert.equal(zoneFromPoint(0.1, 0.9), "bottomLeft");
	assert.equal(zoneFromPoint(0.9, 0.9), "bottomRight");
});

test("zoneFromPoint edge band is 0.30", () => {
	assert.equal(zoneFromPoint(0.29, 0.5), "left");
	assert.equal(zoneFromPoint(0.31, 0.5), "full");
	assert.equal(zoneFromPoint(0.5, 0.71), "bottom");
	assert.equal(zoneFromPoint(0.5, 0.69), "full");
});

test("zoneRect returns percentage rects and falls back to full", () => {
	assert.deepEqual(zoneRect("full"), { left: 0, top: 0, width: 100, height: 100 });
	assert.deepEqual(zoneRect("right"), { left: 50, top: 0, width: 50, height: 100 });
	assert.deepEqual(zoneRect("bottomRight"), { left: 50, top: 50, width: 50, height: 50 });
	assert.deepEqual(zoneRect("nonsense"), zoneRect("full"));
});

const M = (over) => ({ value: "\\\\.\\DISPLAY1", label: "m", left: 0, top: 0, width: 1600, height: 900, isPrimary: false, ...over });

test("layoutMonitors returns empty box for no monitors", () => {
	assert.deepEqual(layoutMonitors([]), { boxWidth: 0, boxHeight: 0, monitors: [] });
});

test("layoutMonitors scales two side-by-side monitors to fit", () => {
	const r = layoutMonitors(
		[M({ value: "\\\\.\\DISPLAY1", left: 0, isPrimary: true }), M({ value: "\\\\.\\DISPLAY2", left: 1600 })],
		320,
		180,
	);
	assert.equal(r.boxWidth, 320);
	assert.equal(r.boxHeight, 90);
	assert.deepEqual({ x: r.monitors[0].x, y: r.monitors[0].y, w: r.monitors[0].w, h: r.monitors[0].h }, { x: 0, y: 0, w: 160, h: 90 });
	assert.deepEqual({ x: r.monitors[1].x, y: r.monitors[1].y, w: r.monitors[1].w, h: r.monitors[1].h }, { x: 160, y: 0, w: 160, h: 90 });
	assert.equal(r.monitors[0].isPrimary, true);
});

test("layoutMonitors keeps a negative-left monitor on the left and fits the box", () => {
	const r = layoutMonitors(
		[M({ value: "\\\\.\\DISPLAY1", left: -1280, width: 1280, height: 1024 }), M({ value: "\\\\.\\DISPLAY2", left: 0, width: 1920, height: 1080, isPrimary: true })],
		320,
		180,
	);
	assert.equal(r.monitors[0].x, 0, "leftmost monitor starts at x=0");
	assert.ok(r.monitors[1].x > r.monitors[0].x, "monitor to the right has a greater x");
	assert.ok(r.boxWidth <= 320 && r.boxHeight <= 180, "layout fits the bounds");
});

test("layoutMonitors preserves a portrait monitor's aspect", () => {
	const r = layoutMonitors([M({ width: 1080, height: 1920 })], 200, 200);
	assert.ok(r.monitors[0].h > r.monitors[0].w, "portrait stays taller than wide");
});
