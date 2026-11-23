import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	buildLaunchScript,
	runPowerShell,
	ZONE_HELPERS,
	type LaunchConfig,
} from "../src/platform/windows/powershell.ts";

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
const zoneCases: ZoneCase[] = JSON.parse(
	readFileSync(new URL("./fixtures/zone-cases.json", import.meta.url), "utf8"),
).cases;

/** Computes every zone against one work area in a single PowerShell spawn. */
function allZoneRects(left: number, top: number, width: number, height: number): Promise<Record<string, Rect>> {
	const zones = [
		"full",
		"left",
		"right",
		"top",
		"bottom",
		"topLeft",
		"topRight",
		"bottomLeft",
		"bottomRight",
		"bogus",
	];
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

function resolveMonitor(
	monitors: { DeviceName: string; IsPrimary: boolean }[],
	monitorId: string,
): Promise<{ device: string }> {
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

type CentreCase = {
	name: string;
	workArea: { left: number; top: number; width: number; height: number };
	size: { width: number; height: number };
	expected: Rect;
};

/** The centred-window contract, shared with macOS like the zone table. */
const centreCases: CentreCase[] = JSON.parse(
	readFileSync(new URL("./fixtures/centre-cases.json", import.meta.url), "utf8"),
).cases;

test("Windows centred-window geometry matches the shared contract", async () => {
	// Every case in a single PowerShell spawn, keyed by its position in the table.
	const calls = centreCases
		.map(
			({ workArea: a, size: s }, i) =>
				`$out['${i}'] = Get-CentredRect ${a.left} ${a.top} ${a.width} ${a.height} ${s.width} ${s.height}`,
		)
		.join("\n");
	const script = `
${ZONE_HELPERS}
$out = @{}
${calls}
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
	const actual = await runPowerShell<Record<string, Rect>>(script, 30_000);
	centreCases.forEach((c, i) => assert.deepEqual(actual[String(i)], c.expected, c.name));
});

test("a centred custom key centres on its monitor's work area, resolved at press time", () => {
	const config: LaunchConfig = {
		appPath: "C:\\Windows\\notepad.exe",
		launchArgs: "",
		titleFilter: "",
		processName: "",
		focusIfRunning: true,
		positionMode: "custom",
		monitorId: "\\\\.\\DISPLAY2",
		zone: "full",
		waitSeconds: 10,
		x: 0,
		y: 0,
		width: 1280,
		height: 800,
		centreOnDisplay: true,
		virtualDesktop: "",
	};
	const script = buildLaunchScript(config);
	assert.ok(script.includes('"centreOnDisplay":true'), "the flag reaches the script");
	assert.match(script, /\$cfg\.positionMode -eq 'custom' -and \$cfg\.centreOnDisplay/);
	assert.match(
		script,
		/Resolve-TargetMonitor \$mons \$cfg\.monitorId\s+\$rect = Get-CentredRect \(\[int\]\$mon\.WorkLeft\)/,
	);
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
