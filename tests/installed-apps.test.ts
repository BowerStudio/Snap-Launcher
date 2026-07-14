import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInstalledListScript, runPowerShell, type InstalledApp } from "../src/powershell.ts";

test("buildInstalledListScript lists installed applications", async () => {
	const apps = await runPowerShell<InstalledApp[]>(buildInstalledListScript(), 60_000);

	assert.ok(Array.isArray(apps), "expected a JSON array");
	assert.ok(apps.length >= 1, "a Windows machine has at least one installed app");

	for (const a of apps) {
		assert.ok(typeof a.name === "string" && a.name.length > 0, "every entry has a display name");
		assert.ok(typeof a.path === "string" && a.path.length > 0, "every entry has a launchable value");
		const isLnk = /\.lnk$/i.test(a.path);
		const isAumid = /^shell:AppsFolder\\.+!.+$/i.test(a.path);
		assert.ok(isLnk || isAumid, `value is a .lnk path or shell:AppsFolder AUMID, got: ${a.path}`);
	}

	// No duplicate values — each entry must be a distinct thing to launch.
	const values = apps.map((a) => a.path.toLowerCase());
	assert.equal(new Set(values).size, values.length, "no duplicate values");
});
