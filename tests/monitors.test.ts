import assert from "node:assert/strict";
import { test } from "node:test";

import { windowsBackend } from "../src/platform/windows/index.ts";
import { buildMonitorListScript, runPowerShell, type MonitorEntry } from "../src/platform/windows/powershell.ts";

/** The script predates MonitorEntry.index; the backend derives it. */
type RawMonitor = Omit<MonitorEntry, "index">;

test("buildMonitorListScript reports the machine's monitors", async () => {
	const monitors = await runPowerShell<RawMonitor[]>(buildMonitorListScript(), 30_000);

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

test("the Windows backend derives an arrangement index without touching deviceName", async () => {
	const raw = await runPowerShell<RawMonitor[]>(buildMonitorListScript(), 30_000);
	const monitors = await windowsBackend.listMonitors();

	assert.equal(monitors.length, raw.length, "the backend reports every monitor the script found");

	for (const m of monitors) {
		// deviceName is persisted as a key's monitorId — it must survive byte-identical.
		assert.ok(
			raw.some((r) => r.deviceName === m.deviceName),
			`deviceName passed through unchanged: ${m.deviceName}`,
		);
		assert.equal(m.index, Number(/(\d+)$/.exec(m.deviceName)?.[1]), "index comes from the DISPLAYn ordinal");
	}
});
