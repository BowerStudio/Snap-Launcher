/**
 * Windows refuses to let a non-elevated process move, resize or minimize an
 * elevated app's window (Task Manager, anything run as administrator), and the
 * refusal is silent. The launch script must notice, hand the window to the
 * administrator helper when one is set up, and otherwise say why nothing moved
 * rather than report a success.
 *
 * The helper itself runs elevated, so what it accepts is a security boundary:
 * it is compiled here for real and fed malformed requests.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { controlsFor } from "../com.bowerstudio.snap-launcher.sdPlugin/ui/admin-helper.js";
import {
	HELPER_SOURCE,
	HELPER_TASK,
	HELPER_VERSION,
	buildElevateScript,
	buildInstallerScript,
	buildUninstallerScript,
	describeHelperExit,
	describeHelperStatus,
} from "../src/platform/windows/elevation.ts";
import { buildLaunchScript, runPowerShell, type LaunchConfig } from "../src/platform/windows/powershell.ts";

const launch = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
	appPath: "C:\\Windows\\System32\\Taskmgr.exe",
	launchArgs: "",
	titleFilter: "",
	processName: "",
	focusIfRunning: true,
	positionMode: "zone",
	monitorId: "primary",
	zone: "left",
	waitSeconds: 10,
	x: 0,
	y: 0,
	width: 0,
	height: 0,
	virtualDesktop: "",
	...over,
});

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const CHECK = "[Native]::IsBlockedByElevation([int]$target.Id)";

/* ------------------------------ launch script ------------------------------ */

test("an elevated window is detected before it is touched", () => {
	const script = buildLaunchScript(launch());
	const check = script.indexOf(CHECK);
	assert.ok(check !== -1, "the launch script checks the target's elevation");
	const body = script.slice(script.indexOf("$hwnd = $target.MainWindowHandle"));
	assert.ok(body.indexOf(CHECK) < body.indexOf("ShowWindow($hwnd, 6)"), "before minimizing");
	assert.ok(body.indexOf(CHECK) < body.indexOf("ShowWindow($hwnd, 9)"), "before restoring");
	assert.ok(body.indexOf(CHECK) < body.indexOf("Set-TargetRect $hwnd"), "and before moving");
});

test("a key that doesn't touch the window is never refused for elevation", () => {
	const script = buildLaunchScript(launch({ positionMode: "none" }));
	assert.ok(script.includes(`if ($cfg.positionMode -ne 'none' -and ${CHECK})`));
});

test("an elevated window goes to the helper, or fails saying how to set it up", () => {
	const script = buildLaunchScript(launch());
	assert.match(
		script,
		/\$viaHelper = Get-ElevationHelper\s*\n\s*if \(-not \$viaHelper\) \{ throw \(Get-ElevationMessage/,
	);
	assert.ok(script.includes("is running as administrator"));
	assert.ok(script.includes('Set up the administrator helper (under "Apps running as administrator"'));
});

test("through the helper, minimize and move become helper requests", () => {
	const script = buildLaunchScript(launch());
	assert.ok(script.includes("Invoke-HelperRequest $viaHelper ('min:' + $hwnd.ToInt64())"));
	assert.ok(script.includes("Invoke-HelperRequest $script:viaHelper ('pos:{0}:{1}:{2}:{3}:{4}'"));
	assert.ok(
		script.includes("if (-not $viaHelper -and ([Native]::IsIconic($hwnd)"),
		"the refused direct restore is skipped",
	);
});

test("a move refused with access denied falls back to the helper", () => {
	const script = buildLaunchScript(launch());
	assert.match(script, /GetLastWin32Error\(\) -ne 5\) \{ return \}\s*\n\s*\$script:viaHelper = Get-ElevationHelper/);
});

/* -------------------------------- installer -------------------------------- */

test("the installer only accepts a real SID", () => {
	assert.throws(() => buildInstallerScript("S-1-5-21-1'; Remove-Item C:\\ -Recurse; '"), /Not a security identifier/);
	assert.throws(() => buildInstallerScript(""), /Not a security identifier/);
	assert.ok(buildInstallerScript(SID).includes(`$sid = '${SID}'`));
});

test("the task runs the Program Files helper, highest privileges, user may only read and run it", () => {
	const script = buildInstallerScript(SID);
	assert.ok(script.includes("Join-Path $env:ProgramFiles 'Snap Launcher'"), "admin-only install location");
	assert.ok(script.includes("$def.Principal.RunLevel = 1"), "highest privileges");
	assert.ok(script.includes("$def.Principal.LogonType = 3"), "in the user's own session");
	assert.ok(script.includes("$action.Arguments = '$(Arg0)'"), "the request is the only argument");
	assert.ok(
		script.includes("'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + $sid + ')'"),
		"the user gets read+execute on the task, never write",
	);
	assert.ok(script.includes(`RegisterTaskDefinition('${HELPER_TASK}'`));
});

test("the uninstaller removes both the task and the program", () => {
	const script = buildUninstallerScript();
	assert.ok(script.includes(`DeleteTask('${HELPER_TASK}', 0)`));
	assert.ok(script.includes("Remove-Item -LiteralPath $dir -Recurse -Force"));
});

test("the elevated script travels encoded, never as a file", () => {
	const script = buildElevateScript("exit 0");
	assert.ok(script.includes("-Verb RunAs"));
	assert.ok(script.includes(`'-EncodedCommand', '${Buffer.from("exit 0", "utf16le").toString("base64")}'`));
	assert.ok(!/['\s]-File['\s]/.test(script), "no -File argument");
});

/* ------------------------------ helper program ----------------------------- */

test("the helper refuses anything but a well-formed request for a live top-level window", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "snap-helper-test-"));
	const exe = path.join(dir, "helper.exe");
	try {
		const requests = [
			[], // no request
			["min:1", "extra"], // more than one argument
			["min"], // no window
			["min:abc"],
			["min:-5"],
			["min:0"],
			["kill:12345"], // unknown verb
			["pos:12345:1:2:3"], // too few fields
			["pos:12345:1:2:0:10"], // empty size
			["pos:12345:1:2:99999999:10"], // absurd size
			["pos:12345:1:2:3:4:5"], // too many fields
			["min:" + "9".repeat(200)], // overlong
			["min:999999999"], // no such window
		];
		const runs = requests
			.map((args) => {
				const list = args.map((a) => `'${a}'`).join(",");
				return `$p = Start-Process -FilePath '${exe}' -Wait -PassThru${args.length ? ` -ArgumentList @(${list})` : ""}; $codes += $p.ExitCode`;
			})
			.join("\n");
		const script = `
$ErrorActionPreference = 'Stop'
$source = @'
${HELPER_SOURCE}
'@
Add-Type -TypeDefinition $source -OutputAssembly '${exe}' -OutputType WindowsApplication
$codes = @()
${runs}
$version = (Get-Item -LiteralPath '${exe}').VersionInfo.FileVersion
Write-Output (ConvertTo-Json -InputObject @{ codes = $codes; version = $version } -Compress)
`;
		const result = await runPowerShell<{ codes: number[]; version: string }>(script, 120_000);
		assert.deepEqual(result.codes, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3]);
		assert.equal(result.version, HELPER_VERSION, "the version the status check compares against");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/* ---------------------------------- status --------------------------------- */

test("helper status reads plainly in every state", () => {
	const raw = { ok: true, task: true, exe: true, version: HELPER_VERSION, current: true };
	assert.deepEqual(describeHelperStatus(raw).installed, true);
	assert.match(describeHelperStatus(raw).message, /^Set up/);
	assert.match(describeHelperStatus({ ...raw, current: false, version: "0.9.0.0" }).message, /older version/);
	assert.equal(describeHelperStatus({ ...raw, exe: false }).installed, false);
	assert.match(describeHelperStatus({ ...raw, exe: false }).message, /partly/);
	assert.equal(describeHelperStatus({ ...raw, task: false, exe: false }).message, "Not set up.");
	assert.equal(describeHelperExit(0), "");
	assert.match(describeHelperExit(12), /scheduled task/);
	assert.match(describeHelperExit(99), /99/);
});

test("the PI hides the buttons while the prompt is up and offers Remove only when set up", () => {
	assert.deepEqual(controlsFor(null), {
		message: "Checking…",
		setupHidden: false,
		setupLabel: "Set up helper…",
		removeHidden: true,
	});
	const busy = controlsFor({ busy: true, installed: false, message: "Waiting" });
	assert.equal(busy.setupHidden, true);
	assert.equal(busy.removeHidden, true);
	const installed = controlsFor({ busy: false, installed: true, message: "Set up" });
	assert.equal(installed.removeHidden, false);
	assert.match(installed.setupLabel, /again/);
});
