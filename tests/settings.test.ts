import assert from "node:assert/strict";
import { test } from "node:test";

import { ICON_LOOKUP_VERSION, needsIconLookup } from "../src/actions/pickers.ts";
import { toConfig } from "../src/settings.ts";

const RECT = { x: "100", y: "50", width: "800", height: "600" };

test("explicit positionMode wins over legacy applyPosition", () => {
	const c = toConfig({
		appPath: "a.exe",
		positionMode: "zone",
		applyPosition: false,
		monitorId: "\\\\.\\DISPLAY2",
		zone: "left",
	});
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

test("centred custom mode needs only a size, not x/y", () => {
	const c = toConfig({
		appPath: "a.exe",
		positionMode: "custom",
		centreOnDisplay: true,
		monitorId: "\\\\.\\DISPLAY2",
		width: "1280",
		height: "800",
	});
	assert.equal(c.positionMode, "custom");
	assert.equal(c.centreOnDisplay, true);
	assert.equal(c.monitorId, "\\\\.\\DISPLAY2");
	assert.deepEqual([c.width, c.height], [1280, 800]);
	assert.deepEqual([c.x, c.y], [0, 0], "no position is needed or invented");
});

test("centred custom mode keeps a captured x/y without using it", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "custom", centreOnDisplay: true, ...RECT });
	assert.equal(c.centreOnDisplay, true);
	assert.deepEqual([c.x, c.y, c.width, c.height], [100, 50, 800, 600]);
});

test("centred custom mode without a size degrades to none", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "custom", centreOnDisplay: true, x: "10", y: "10" });
	assert.equal(c.positionMode, "none");
	assert.equal(c.centreOnDisplay, false);
	assert.deepEqual([c.width, c.height], [0, 0]);
});

test("unticked centre keeps the plain rectangle behaviour", () => {
	const c = toConfig({
		appPath: "a.exe",
		positionMode: "custom",
		centreOnDisplay: false,
		width: "800",
		height: "600",
	});
	assert.equal(c.positionMode, "none", "a size alone is not a rectangle");
	assert.equal(c.centreOnDisplay, false);
});

test("centring only applies in custom mode", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "zone", centreOnDisplay: true, zone: "left", ...RECT });
	assert.equal(c.positionMode, "zone");
	assert.equal(c.centreOnDisplay, false);
});

test("zone mode needs no rect", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "zone", zone: "bottomRight" });
	assert.equal(c.positionMode, "zone");
	assert.equal(c.zone, "bottomRight");
});

test("minimize mode is accepted and needs no rect", () => {
	const c = toConfig({ appPath: "a.exe", positionMode: "minimize" });
	assert.equal(c.positionMode, "minimize");
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

test("an icon is looked up when the app changes, and a miss is retried once the lookup improves", () => {
	const app = "steam:2807960";
	assert.equal(needsIconLookup({ appPath: app }), true, "never looked up");
	assert.equal(needsIconLookup({ appPath: "steam:1", iconFor: app }), true, "a different app");
	assert.equal(
		needsIconLookup({ appPath: app, iconFor: app, autoImage: "data:image/png;base64,x" }),
		false,
		"a found icon is kept for good",
	);
	assert.equal(needsIconLookup({ appPath: app, iconFor: app, autoImage: "" }), true, "a miss by the old lookup");
	assert.equal(
		needsIconLookup({ appPath: app, iconFor: app, autoImage: "", iconLookup: ICON_LOOKUP_VERSION }),
		false,
		"a miss by the current lookup is not retried on every start",
	);
	assert.equal(needsIconLookup({ appPath: "", iconFor: "" }), false, "no app, nothing to look up");
});
