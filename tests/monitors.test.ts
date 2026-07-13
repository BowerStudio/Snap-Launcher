import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMonitorListScript, runPowerShell, type MonitorEntry } from "../src/powershell.ts";

test("buildMonitorListScript reports the machine's monitors", async () => {
	const monitors = await runPowerShell<MonitorEntry[]>(buildMonitorListScript(), 30_000);

	assert.ok(Array.isArray(monitors), "expected a JSON array");
	assert.ok(monitors.length >= 1, "at least one monitor must exist");
	assert.equal(monitors.filter((m) => m.isPrimary).length, 1, "exactly one primary monitor");

	for (const m of monitors) {
		assert.match(m.deviceName, /^\\\\.\\DISPLAY\d+$/, "device name looks like \\\\.\\DISPLAYn");
		assert.ok(m.width > 0 && m.height > 0, "monitor bounds are positive");
		assert.ok(m.workWidth > 0 && m.workHeight > 0, "work area is positive");
		assert.ok(m.workWidth <= m.width, "work area fits inside the monitor");
		assert.ok(m.workHeight <= m.height, "work area fits inside the monitor");
	}
});
