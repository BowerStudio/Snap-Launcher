import assert from "node:assert/strict";
import { test } from "node:test";

import { toCloseConfig } from "../src/settings.ts";

test("close mode defaults to graceful and rejects unknown values", () => {
	assert.equal(toCloseConfig({}).closeMode, "close");
	assert.equal(toCloseConfig({ closeMode: "bogus" }).closeMode, "close");
	assert.equal(toCloseConfig({ closeMode: "closeThenKill" }).closeMode, "closeThenKill");
	assert.equal(toCloseConfig({ closeMode: "kill" }).closeMode, "kill");
});

test("close wait seconds coerces strings and clamps to 1..60", () => {
	assert.equal(toCloseConfig({}).waitSeconds, 5);
	assert.equal(toCloseConfig({ waitSeconds: "12" }).waitSeconds, 12);
	assert.equal(toCloseConfig({ waitSeconds: "" }).waitSeconds, 5);
	assert.equal(toCloseConfig({ waitSeconds: 0 }).waitSeconds, 1);
	assert.equal(toCloseConfig({ waitSeconds: 999 }).waitSeconds, 60);
});

test("close config trims identification fields", () => {
	const c = toCloseConfig({ appPath: "  C:\\x.exe  ", titleFilter: " foo ", processName: " Bar " });
	assert.equal(c.appPath, "C:\\x.exe");
	assert.equal(c.titleFilter, "foo");
	assert.equal(c.processName, "Bar");
});
