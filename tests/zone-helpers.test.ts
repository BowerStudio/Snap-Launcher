import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { runPowerShell, ZONE_HELPERS } from "../src/platform/windows/powershell.ts";

type Rect = { x: number; y: number; width: number; height: number };
type ZoneCase = {
	name: string;
	workArea: { left: number; top: number; width: number; height: number };
	zones: Record<string, Rect>;
};

/**
 * The zone contract shared with the macOS implementation. Both must satisfy
 * the same table, which is what stops the two from drifting apart — see
 * tests/macos-window-control.test.ts for the other half.
 */
const zoneCases: ZoneCase[] = JSON.parse(readFileSync(new URL("./fixtures/zone-cases.json", import.meta.url), "utf8")).cases;

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

for (const zoneCase of zoneCases) {
	test(`Windows zone geometry matches the shared contract: ${zoneCase.name}`, async () => {
		const { left, top, width, height } = zoneCase.workArea;
		const actual = await allZoneRects(left, top, width, height);
		for (const [zone, expected] of Object.entries(zoneCase.zones)) {
			assert.deepEqual(actual[zone], expected, `${zoneCase.name} / ${zone}`);
		}
	});
}

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
