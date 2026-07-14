import assert from "node:assert/strict";
import { test } from "node:test";

import { runPowerShell, VDESK } from "../src/powershell.ts";

type VdProbe = { ok: boolean; error?: string; count: number; current: number; names: string[]; foundByName: number };

/**
 * Read-only probe of the virtual-desktop COM interop against the live shell:
 * initializes the wrapper, enumerates desktops, and resolves the current one.
 * Deliberately never creates, switches, or moves anything — the suite must
 * not disturb the desktop session it runs in.
 */
test("virtual-desktop interop initializes and enumerates desktops (Windows 11)", async () => {
	const script = `
$ErrorActionPreference = 'Stop'
${VDESK}
try {
    Initialize-VDesk
    $names = [SnapVD.VDesk]::List()
    $current = [SnapVD.VDesk]::CurrentIndex()
    $found = [SnapVD.VDesk]::FindByName($names[$current])
    $out = @{ ok = $true; count = [SnapVD.VDesk]::Count; current = $current; names = @($names); foundByName = $found }
} catch {
    $out = @{ ok = $false; error = $_.Exception.Message; count = 0; current = -1; names = @(); foundByName = -1 }
}
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
	const probe = await runPowerShell<VdProbe>(script, 30_000);

	if (!probe.ok && /Windows 11/.test(probe.error ?? "")) {
		// Pre-Win11 machine: the clear rejection IS the correct behavior.
		return;
	}

	assert.ok(probe.ok, `interop failed: ${probe.error}`);
	assert.ok(probe.count >= 1, "at least one virtual desktop exists");
	assert.equal(probe.names.length, probe.count, "one name per desktop");
	assert.ok(probe.current >= 0 && probe.current < probe.count, "current desktop resolves to a valid index");
	assert.equal(probe.foundByName, probe.current, "FindByName round-trips the current desktop's name");
	for (const n of probe.names) {
		assert.ok(typeof n === "string" && n.length > 0, "every desktop has a non-empty name");
	}
});
