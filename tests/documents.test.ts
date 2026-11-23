/**
 * Keys pointed at a document rather than an app: a file Windows opens in
 * whatever is registered for its type.
 *
 * As with the Steam scripts, everything here is deterministic and harmless.
 * Nothing is ever opened: the files are made up on the spot, so no window can
 * be showing them, which exercises target resolution, window matching and
 * every failure path without starting an app on the machine running the tests.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { toAppIconResult, type RawAppIcon } from "../src/platform/icons.ts";
import {
	buildAppIconScript,
	buildCaptureScript,
	buildCloseScript,
	buildLaunchScript,
	DOCUMENT_HELPERS,
	runPowerShell,
	type CaptureResult,
	type CloseConfig,
	type CloseResult,
	type LaunchConfig,
	type LaunchResult,
} from "../src/platform/windows/powershell.ts";

const TIMEOUT_MS = 60_000;

/** A temp folder holding the named files, removed when the test ends. */
function folder(t: TestContext, files: string[]): string {
	const dir = mkdtempSync(path.join(tmpdir(), "snap-launcher-doc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const name of files) {
		writeFileSync(path.join(dir, name), "snap launcher test\n");
	}
	return dir;
}

const launch = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
	appPath: "",
	launchArgs: "",
	titleFilter: "",
	processName: "",
	focusIfRunning: true,
	positionMode: "zone",
	monitorId: "primary",
	zone: "left",
	waitSeconds: 1,
	x: 0,
	y: 0,
	width: 0,
	height: 0,
	centreOnDisplay: false,
	virtualDesktop: "",
	...over,
});

const close = (over: Partial<CloseConfig> = {}): CloseConfig => ({
	appPath: "",
	titleFilter: "",
	processName: "",
	closeMode: "close",
	waitSeconds: 1,
	...over,
});

/** Embeds a string as a single-quoted PowerShell literal. */
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;

/* ----------------------------- what is a document -------------------------- */

test("a file that exists and is not a program is a document", async (t) => {
	const dir = folder(t, [
		"notes.txt",
		"MyGame.uproject",
		"photo.JPG",
		"LICENSE",
		"tool.exe",
		"run.bat",
		"build.CMD",
		"app.lnk",
	]);
	mkdirSync(path.join(dir, "folder.txt"));

	const names = [
		"notes.txt",
		"MyGame.uproject",
		"photo.JPG",
		"LICENSE",
		"tool.exe",
		"run.bat",
		"build.CMD",
		"app.lnk",
		"folder.txt",
		"missing.txt",
	];
	const script = `
${DOCUMENT_HELPERS}
$out = @{}
foreach ($name in @(${names.map(ps).join(", ")})) {
    $out[$name] = Test-DocumentPath (Join-Path ${ps(dir)} $name)
}
$out['notepad'] = Test-DocumentPath 'notepad'
$out[''] = Test-DocumentPath ''
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
	const result = await runPowerShell<Record<string, boolean>>(script, TIMEOUT_MS);

	assert.deepEqual(result, {
		"notes.txt": true,
		"MyGame.uproject": true,
		"photo.JPG": true,
		// No extension at all is still a file Windows opens rather than runs.
		LICENSE: true,
		"tool.exe": false,
		"run.bat": false,
		"build.CMD": false,
		"app.lnk": false,
		// A folder is not a file, whatever it is called...
		"folder.txt": false,
		// ...and a document that has been moved away must fail as a missing
		// file, not be waited for.
		"missing.txt": false,
		// A bare command name is a program to start, as it always was.
		notepad: false,
		"": false,
	});
});

/* ------------------------------ naming the file ---------------------------- */

/** Which of the titles carry the name, in one PowerShell spawn. */
async function named(name: string, titles: string[]): Promise<boolean[]> {
	const script = `
${DOCUMENT_HELPERS}
$pattern = Get-NamePattern ${ps(name)}
$out = @(${titles.map(ps).join(", ")}) | ForEach-Object { [bool](Test-NameIn $_ $pattern) }
Write-Output (ConvertTo-Json -InputObject @{ hits = @($out) } -Compress)
`;
	return (await runPowerShell<{ hits: boolean[] }>(script, TIMEOUT_MS)).hits;
}

test("a window title names a file only as a whole name", async () => {
	const titles: [string, boolean][] = [
		["notes.txt - Notepad", true],
		["*notes.txt - Notepad", true],
		["NOTES.TXT - Notepad", true],
		["Photos - notes.txt", true],
		["Blender [C:\\work\\notes.txt]", true],
		["file:///C:/work/notes.txt - Google Chrome", true],
		// A longer name that merely ends or begins the same way is another file.
		["meeting-notes.txt - Notepad", false],
		["mynotes.txt - Notepad", false],
		["notes.txt2 - Notepad", false],
		["notes - Notepad", false],
		["", false],
	];
	assert.deepEqual(
		await named(
			"notes.txt",
			titles.map(([title]) => title),
		),
		titles.map(([, expected]) => expected),
	);
});

test("a name without its extension still finds the window that shows it with one", async () => {
	const titles: [string, boolean][] = [
		["MyGame - Unreal Editor", true],
		["Unreal Editor - MyGame", true],
		["MyGame.uproject - Visual Studio Code", true],
		["MyGame2 - Unreal Editor", false],
		["MyGame_Backup - Unreal Editor", false],
		["NotMyGame - Unreal Editor", false],
	];
	assert.deepEqual(
		await named(
			"MyGame",
			titles.map(([title]) => title),
		),
		titles.map(([, expected]) => expected),
	);
});

test("a name made of regex characters is matched literally", async () => {
	assert.deepEqual(
		await named("report (final) [v2].txt", ["report (final) [v2].txt - Notepad", "report final v2.txt"]),
		[true, false],
	);
});

/* ---------------------------- what was started with it -------------------- */

test("a process started with the file on its command line is recognised", async (t) => {
	// Stands in for the editor a launcher starts: UnrealVersionSelector runs
	// UnrealEditor with the .uproject as its argument, and nothing but that
	// command line connects the editor's window to the file. A windowless
	// child that only sleeps is all it takes to have one to read.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "C:\\work\\MyGame.uproject"], {
		stdio: "ignore",
		windowsHide: true,
	});
	t.after(() => child.kill());
	assert.ok(child.pid, "the stand-in process started");

	const script = `
${DOCUMENT_HELPERS}
$out = @{
    started = Test-StartedWithFile ${child.pid} (Get-NamePattern 'MyGame.uproject')
    otherFile = Test-StartedWithFile ${child.pid} (Get-NamePattern 'Game.uproject')
    otherProcess = Test-StartedWithFile $PID (Get-NamePattern 'MyGame.uproject')
    goneProcess = Test-StartedWithFile 4194300 (Get-NamePattern 'MyGame.uproject')
}
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
	const result = await runPowerShell<Record<string, boolean>>(script, TIMEOUT_MS);

	assert.deepEqual(result, {
		started: true,
		// A different file whose name this one merely ends with.
		otherFile: false,
		otherProcess: false,
		// No such process is an ordinary "no", never an error.
		goneProcess: false,
	});
});

/* ------------------------------- what opens it ----------------------------- */

type Opener = { ProcessName: string | null; PackageRoot: string | null; Aumid: string | null; Exe: string | null };

function opener(file: string): Promise<Opener> {
	// The Store-app helpers are stubbed: this is about reading the association,
	// and a real package lookup would make the answer depend on the machine.
	const script = `
function Get-PackageForAumid([string]$aumid) { return $null }
function Test-PackagedPath([string]$p) { return $false }
function Resolve-PathPackage([string]$p) { return $null }
${DOCUMENT_HELPERS}
$o = Get-DocumentOpener ${ps(file)}
Write-Output (ConvertTo-Json -InputObject @{ ProcessName = $o.ProcessName; PackageRoot = $o.PackageRoot; Aumid = $o.Aumid; Exe = $o.Exe } -Compress)
`;
	return runPowerShell<Opener>(script, TIMEOUT_MS);
}

test("a file type nothing is registered for has no opener, which is not an error", async (t) => {
	const dir = folder(t, ["thing.snaplaunchertest", "LICENSE"]);

	for (const name of ["thing.snaplaunchertest", "LICENSE"]) {
		const found = await opener(path.join(dir, name));
		// Windows answers an unknown type with its own "open with" picker,
		// which must not be mistaken for the app that opens the file.
		assert.deepEqual(found, { ProcessName: null, PackageRoot: null, Aumid: null, Exe: null }, name);
	}
});

/* ------------------------------ whole scripts ------------------------------ */

test("capturing a document nothing has open fails in-band, naming the file", async (t) => {
	const dir = folder(t, ["snap-launcher-unopened.txt"]);
	const config = launch({
		appPath: path.join(dir, "snap-launcher-unopened.txt"),
		titleFilter: "no such window title",
	});
	const result = await runPowerShell<CaptureResult>(buildCaptureScript(config), TIMEOUT_MS);

	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /"snap-launcher-unopened\.txt" does not appear to be open/);
});

test("a document of an unregistered type resolves without an app to look for", async (t) => {
	// No opener means no process to match by, which must come out as "no
	// window" rather than as a null dereference inside the matching.
	const dir = folder(t, ["thing.snaplaunchertest"]);
	const config = launch({ appPath: path.join(dir, "thing.snaplaunchertest") });
	const result = await runPowerShell<CaptureResult>(buildCaptureScript(config), TIMEOUT_MS);

	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /"thing\.snaplaunchertest" does not appear to be open/);
});

test("closing a document nothing has open finds nothing, and leaves its app alone", async (t) => {
	// The app that opens .txt files may well be running with other files in
	// it. None of those windows shows this file, so none may be closed.
	const dir = folder(t, ["snap-launcher-unopened.txt"]);
	const config = close({ appPath: path.join(dir, "snap-launcher-unopened.txt"), closeMode: "kill" });
	const result = await runPowerShell<CloseResult>(buildCloseScript(config), TIMEOUT_MS);

	assert.deepEqual(result, { ok: true, found: 0, closed: 0, killed: 0 });
});

test("launching a document that has gone missing fails in-band", async (t) => {
	const dir = folder(t, []);
	const config = launch({ appPath: path.join(dir, "snap-launcher-missing.txt") });
	const result = await runPowerShell<LaunchResult>(buildLaunchScript(config), TIMEOUT_MS);

	assert.equal(result.ok, false, "nothing can be opened, so this is a failed press");
});

test("a document is opened without the key's arguments, and an app still gets them", () => {
	const script = buildLaunchScript(launch({ appPath: "C:\\work\\notes.txt", launchArgs: "--flag" }));

	assert.match(script, /if \(\$cfg\.launchArgs -and -not \$doc\) \{ \$sp\['ArgumentList'\] = \$cfg\.launchArgs \}/);
	// Store apps and Steam games are launched by their own branches, untouched.
	assert.match(script, /\$sp = @\{ FilePath = \('shell:AppsFolder\\' \+ \$aumid\) \}/);
	assert.match(script, /\$sp = @\{ FilePath = \$steam\.launchUrl \}/);
});

test("a document that opens with nothing to position is a successful press", () => {
	const script = buildLaunchScript(launch({ appPath: "C:\\work\\notes.txt", positionMode: "none" }));

	// Only when the key wants nothing done to the window, and only for a
	// document: an app that never shows a window is still a failed press.
	const giveUp = script.indexOf(
		"if (-not $target -and $doc -and $cfg.positionMode -eq 'none' -and -not $cfg.virtualDesktop) {",
	);
	const timeout = script.indexOf("throw ('Timed out waiting for a window of \"'");
	assert.ok(giveUp !== -1 && timeout !== -1 && giveUp < timeout);
});

test("the app that opens a document does not start inside the plugin's folder", () => {
	// Photos, for one, ignores the working directory the shell is handed and
	// inherits the launching process's - the plugin's own folder, which it
	// would then hold open against updates for as long as it kept running.
	const script = buildLaunchScript(launch({ appPath: "C:\\work\\notes.txt" }));

	const leave = script.indexOf(
		"[System.IO.Directory]::SetCurrentDirectory([Environment]::GetFolderPath('UserProfile'))",
	);
	const start = script.indexOf("Start-Process @sp | Out-Null");
	assert.ok(leave !== -1 && start !== -1 && leave < start);
});

/* ---------------------------------- icons ---------------------------------- */

test("a document's key shows an icon for its file type", async (t) => {
	// Every Windows installation opens .txt files with something, and that
	// something has an icon; which app and which icon is the machine's business.
	const dir = folder(t, ["notes.txt"]);
	const raw = await runPowerShell<RawAppIcon>(buildAppIconScript(path.join(dir, "notes.txt")), TIMEOUT_MS);
	const result = toAppIconResult(raw);

	assert.equal(result.found, true, result.found ? "" : result.reason);
	assert.match(result.found ? result.icon.image : "", /^data:image\/png;base64,/);
	assert.ok(
		result.found && !result.icon.sourcePath.toLowerCase().startsWith(dir.toLowerCase()),
		"the icon comes from the app or the file type, never from the document's own folder",
	);
});

test("a document of an unregistered type gets Windows' own blank-file icon, or none", async (t) => {
	// Nothing opens this type, so there is no app to take an icon from. What
	// Explorer shows for it is the generic file icon out of shell32.dll, and
	// that is the right picture for the key too. The .ico sitting beside the
	// file is there to be ignored: a document's folder is not an app's folder.
	const dir = folder(t, ["thing.snaplaunchertest", "thing.ico"]);
	const raw = await runPowerShell<RawAppIcon>(
		buildAppIconScript(path.join(dir, "thing.snaplaunchertest")),
		TIMEOUT_MS,
	);
	const result = toAppIconResult(raw);

	if (result.found) {
		assert.ok(!result.icon.sourcePath.toLowerCase().startsWith(dir.toLowerCase()), result.icon.sourcePath);
	} else {
		assert.match(result.reason, /no app set up to open "thing\.snaplaunchertest"/);
	}
});
