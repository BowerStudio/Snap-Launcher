import assert from "node:assert/strict";
import { test } from "node:test";

import { toConfig } from "../src/settings.ts";

const RECT = { x: "100", y: "50", width: "800", height: "600" };

test("explicit positionMode wins over legacy applyPosition", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "zone", applyPosition: false, monitorId: "\\\\.\\DISPLAY2", zone: "left" });
	assert.equal(c.positionMode, "zone");
	assert.equal(c.monitorId, "\\\\.\\DISPLAY2");
	assert.equal(c.zone, "left");
});

test("legacy applyPosition=true with a rect migrates to custom", () => {
	const c = toConfig({ appPath: "a.exe", applyPosition: true, ...RECT });
	assert.equal(c.positionMode, "custom");
	assert.deepEqual([c.x, c.y, c.width, c.height], [100, 50, 800, 600]);
});

test("legacy applyPosition=false migrates to none", () => {
	const c = toConfig({ appPath: "a.exe", applyPosition: false, ...RECT });
	assert.equal(c.positionMode, "none");
});

test("no mode settings at all defaults to custom (previous default behavior)", () => {
	const c = toConfig({ appPath: "a.exe", ...RECT });
	assert.equal(c.positionMode, "custom");
});

test("custom mode without a valid rect degrades to none (first press still launches)", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "custom" });
	assert.equal(c.positionMode, "none");
});

test("zone mode needs no rect", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "zone", zone: "bottomRight" });
	assert.equal(c.positionMode, "zone");
	assert.equal(c.zone, "bottomRight");
});

test("unknown zone falls back to full, missing monitor falls back to primary", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "zone", zone: "diagonal" });
	assert.equal(c.zone, "full");
	assert.equal(c.monitorId, "primary");
});

test("numeric coercion and clamping still work", () => {
	const c = toConfig({ appPath: "a.exe", waitSeconds: "999", ...RECT });
	assert.equal(c.waitSeconds, 120);
	assert.equal(c.focusIfRunning, true);
});
