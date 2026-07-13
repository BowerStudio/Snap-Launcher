import assert from "node:assert/strict";
import { test } from "node:test";

import { runPowerShell, ZONE_HELPERS } from "../src/powershell.ts";

type Rect = { x: number; y: number; width: number; height: number };

/** Computes every zone against one work area in a single PowerShell spawn. */
function allZoneRects(left: number, top: number, width: number, height: number): Promise<Record<string, Rect>> {
	const zones = ["full", "left", "right", "top", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight", "bogus"];
	const script = `
${ZONE_HELPERS}
$out = @{}
foreach ($z in @(${zones.map((z) => `'${z}'`).join(", ")})) {
    $out[$z] = Get-ZoneRect ${left} ${top} ${width} ${height} $z
}
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
	return runPowerShell<Record<string, Rect>>(script, 30_000);
}

function resolveMonitor(monitors: { DeviceName: string; IsPrimary: boolean }[], monitorId: string): Promise<{ device: string }> {
	const json = JSON.stringify(monitors).replace(/'/g, "''");
	const script = `
${ZONE_HELPERS}
$mons = ConvertFrom-Json '${json}'
$m = Resolve-TargetMonitor $mons '${monitorId}'
Write-Output (ConvertTo-Json -InputObject @{ device = $m.DeviceName } -Compress)
`;
	return runPowerShell<{ device: string }>(script, 30_000);
}

test("zones tile a 1920x1040 work area at the origin", async () => {
	const r = await allZoneRects(0, 0, 1920, 1040);
	assert.deepEqual(r.full, { x: 0, y: 0, width: 1920, height: 1040 });
	assert.deepEqual(r.left, { x: 0, y: 0, width: 960, height: 1040 });
	assert.deepEqual(r.right, { x: 960, y: 0, width: 960, height: 1040 });
	assert.deepEqual(r.top, { x: 0, y: 0, width: 1920, height: 520 });
	assert.deepEqual(r.bottom, { x: 0, y: 520, width: 1920, height: 520 });
	assert.deepEqual(r.topLeft, { x: 0, y: 0, width: 960, height: 520 });
	assert.deepEqual(r.topRight, { x: 960, y: 0, width: 960, height: 520 });
	assert.deepEqual(r.bottomLeft, { x: 0, y: 520, width: 960, height: 520 });
	assert.deepEqual(r.bottomRight, { x: 960, y: 520, width: 960, height: 520 });
	assert.deepEqual(r.bogus, r.full, "unknown zone falls back to full");
});

test("odd dimensions tile exactly (right/bottom absorb the extra pixel)", async () => {
	const r = await allZoneRects(0, 0, 1921, 1041);
	assert.deepEqual(r.left, { x: 0, y: 0, width: 960, height: 1041 });
	assert.deepEqual(r.right, { x: 960, y: 0, width: 961, height: 1041 });
	assert.equal(r.left.width + r.right.width, 1921);
	assert.deepEqual(r.top, { x: 0, y: 0, width: 1921, height: 520 });
	assert.deepEqual(r.bottom, { x: 0, y: 520, width: 1921, height: 521 });
	assert.equal(r.top.height + r.bottom.height, 1041);
});

test("zones respect a negative-origin work area (monitor left of primary)", async () => {
	const r = await allZoneRects(-2560, -400, 2560, 1360);
	assert.deepEqual(r.left, { x: -2560, y: -400, width: 1280, height: 1360 });
	assert.deepEqual(r.right, { x: -1280, y: -400, width: 1280, height: 1360 });
	assert.deepEqual(r.bottomRight, { x: -1280, y: 280, width: 1280, height: 680 });
});

const MONITORS = [
	{ DeviceName: "\\\\.\\DISPLAY1", IsPrimary: false },
	{ DeviceName: "\\\\.\\DISPLAY2", IsPrimary: true },
];

test("Resolve-TargetMonitor matches by device name", async () => {
	assert.equal((await resolveMonitor(MONITORS, "\\\\.\\DISPLAY1")).device, "\\\\.\\DISPLAY1");
});

test("Resolve-TargetMonitor honors the primary sentinel", async () => {
	assert.equal((await resolveMonitor(MONITORS, "primary")).device, "\\\\.\\DISPLAY2");
});

test("Resolve-TargetMonitor falls back to primary for a missing monitor", async () => {
	assert.equal((await resolveMonitor(MONITORS, "\\\\.\\DISPLAY7")).device, "\\\\.\\DISPLAY2");
});
