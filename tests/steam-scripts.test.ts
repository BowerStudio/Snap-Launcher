/**
 * The Windows scripts a Steam key produces, run for real.
 *
 * Every case here is deterministic and harmless: a game that is not installed
 * exercises identity resolution, the error path, and the close action's
 * idempotence without starting anything. What must never happen is a failure
 * escaping as a raw PowerShell error — the actions only know how to report a
 * result object.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildCaptureScript,
	buildCloseScript,
	buildLaunchScript,
	runPowerShell,
	type CaptureResult,
	type CloseConfig,
	type CloseResult,
	type LaunchConfig,
	type LaunchResult,
	type SteamTarget,
} from "../src/platform/windows/powershell.ts";

const TIMEOUT_MS = 60_000;

const target = (over: Partial<SteamTarget> = {}): SteamTarget => ({
	appId: "999999999",
	name: "A Game That Is Not Installed",
	installDir: "",
	launchUrl: "steam://rungameid/999999999",
	...over,
});

const launch = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
	appPath: "steam:999999999",
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

const close = (over: Partial<CloseConfig> = {}): CloseConfig => ({
	appPath: "steam:999999999",
	titleFilter: "",
	processName: "",
	closeMode: "close",
	waitSeconds: 5,
	...over,
});

/* ------------------------------ script contents ---------------------------- */

test("the Steam target reaches the script, and only when there is one", () => {
	const withGame = buildLaunchScript(launch(), target({ installDir: "D:\\SteamLibrary\\steamapps\\common\\Game" }));
	assert.match(withGame, /\$steam = ConvertFrom-Json/, "the target is embedded as JSON");
	assert.match(withGame, /steam:\/\/rungameid\/999999999/, "and carries the launch URL");
	assert.match(withGame, /\$sp = @\{ FilePath = \$steam\.launchUrl \}/, "which is what gets launched");

	// An ordinary key must still define the variable, so the shared window-
	// finding code can branch on it without checking whether it exists.
	assert.match(buildLaunchScript(launch({ appPath: "C:\\Windows\\notepad.exe" })), /\$steam = \$null/);
});

/* ----------------------------- identity failures --------------------------- */

test("launching a game that isn't installed fails in-band, naming the game", async () => {
	const result = await runPowerShell<LaunchResult>(buildLaunchScript(launch(), target()), TIMEOUT_MS);

	assert.equal(result.ok, false, "a game with no files cannot be positioned, so this is a failed press");
	assert.match(result.ok === false ? result.error : "", /A Game That Is Not Installed/);
	assert.match(result.ok === false ? result.error : "", /Steam library/);
});

test("capturing a game that isn't installed fails in-band too", async () => {
	const result = await runPowerShell<CaptureResult>(buildCaptureScript(launch(), target()), TIMEOUT_MS);

	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /A Game That Is Not Installed/);
});

test("a missing Store package fails the same legible way", async () => {
	// Same resolution path, and the reason it must report a result object
	// rather than throwing: both are ordinary "this key is stale" situations.
	const config = launch({ appPath: "shell:AppsFolder\\NoSuchPackage_8wekyb3d8bbwe!App" });
	const result = await runPowerShell<LaunchResult>(buildLaunchScript(config), TIMEOUT_MS);

	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /Store package/);
});

/* ------------------------------ close semantics ---------------------------- */

test("closing a game that isn't installed finds nothing, which is success", async () => {
	const result = await runPowerShell<CloseResult>(buildCloseScript(close(), target()), TIMEOUT_MS);

	assert.equal(result.ok, true, "an uninstalled game has nothing running to close");
	assert.equal(result.ok === true && result.found, 0);
	assert.equal(result.ok === true && result.killed, 0);
});

test("closing an installed game that isn't running is also success", async () => {
	// A real directory that owns no windows: matching succeeds and finds none.
	const installed = target({ installDir: "C:\\Program Files\\Snap Launcher Test\\No Such Game" });
	const result = await runPowerShell<CloseResult>(buildCloseScript(close(), installed), TIMEOUT_MS);

	assert.equal(result.ok, true);
	assert.equal(result.ok === true && result.found, 0);
});

/* ----------------------------- window matching ----------------------------- */

test("an installed game's windows are matched by its install directory", async () => {
	// Windows under %SystemRoot% stand in for a game's install directory: the
	// point is that the prefix match runs against the live window list and
	// returns an answer rather than throwing on a null root.
	const installed = target({ installDir: process.env.SystemRoot ?? "C:\\Windows" });
	const result = await runPowerShell<CaptureResult>(buildCaptureScript(launch(), installed), TIMEOUT_MS);

	if (result.ok) {
		assert.ok(result.width > 0 && result.height > 0, "a matched window has a real rectangle");
	} else {
		// No such window open right now — still the matching path, not a crash.
		assert.match(result.error, /does not appear to be running with a visible window/);
	}
});
