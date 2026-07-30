import assert from "node:assert/strict";
import { test } from "node:test";

import { zoneFromPoint, zoneRect } from "../com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js";

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
