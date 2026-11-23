/**
 * Keys pointed at a document rather than an app, on macOS.
 *
 * None of this can be run for real without a Mac, so it is held to what can be
 * checked anywhere: the scripts are well-formed, the pure helpers behave, and
 * the document path is taken — and the app path left alone — when it should be.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { APP_HELPERS, TITLE_HELPERS } from "../src/platform/macos/apps.ts";
import { buildAppIconScript } from "../src/platform/macos/icons.ts";
import { buildCaptureScript, buildLaunchScript } from "../src/platform/macos/windows.ts";
import type { LaunchConfig } from "../src/platform/types.ts";

const launch = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
	appPath: "/Users/x/Documents/notes.txt",
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
	centreOnDisplay: false,
	virtualDesktop: "",
	...over,
});

/* ------------------------------ naming the file ---------------------------- */

function titleNames(title: string, name: string): boolean {
	const sandbox = { title, name, result: false };
	vm.runInNewContext(`${TITLE_HELPERS}\nresult = titleNames(title, name);`, sandbox);
	return sandbox.result;
}

test("a window title names a file only as a whole name", () => {
	// The same cases the Windows backend's Get-NamePattern is held to.
	const titles: [string, boolean][] = [
		["notes.txt", true],
		["notes.txt — Edited", true],
		["NOTES.TXT", true],
		["Preview - notes.txt", true],
		["/Users/x/work/notes.txt", true],
		["meeting-notes.txt", false],
		["mynotes.txt", false],
		["notes.txt2", false],
		["notes", false],
		["", false],
	];
	for (const [title, expected] of titles) {
		assert.equal(titleNames(title, "notes.txt"), expected, title);
	}
});

test("a name without its extension still finds the window that shows it with one", () => {
	// Finder hides extensions by default, and so do most document windows.
	assert.equal(titleNames("MyGame", "MyGame"), true);
	assert.equal(titleNames("MyGame.uproject", "MyGame"), true);
	assert.equal(titleNames("MyGame — Unreal Editor", "MyGame"), true);
	assert.equal(titleNames("MyGame2", "MyGame"), false);
	assert.equal(titleNames("MyGame_Backup", "MyGame"), false);
	assert.equal(titleNames("NotMyGame", "MyGame"), false);
});

test("a name made of regex characters, accents or emoji is matched literally", () => {
	assert.equal(titleNames("report (final) [v2].txt", "report (final) [v2].txt"), true);
	assert.equal(titleNames("report final v2.txt", "report (final) [v2].txt"), false);
	assert.equal(titleNames("Résumé.pdf", "résumé"), true);
	assert.equal(titleNames("😀 plan.md", "😀 plan.md"), true);
});

/* ----------------------------- what is a document -------------------------- */

type Doc = { path: string; name: string; base: string; opener: string | null } | null;

/**
 * Runs documentTarget against a stand-in for the bridge: a set of paths that
 * exist, and the app LaunchServices would answer with. Only the JavaScript is
 * under test — what the real bridge returns is macOS's business.
 */
function documentTarget(identity: string, existing: string[], opener: string | null, steam = false): Doc {
	const sandbox = {
		identity,
		result: null as Doc,
		STEAM: steam ? { name: "A Game", installDir: "/games/a" } : null,
		ObjC: { unwrap: (value: unknown) => value },
		$: {
			NSWorkspace: {
				sharedWorkspace: {
					URLForApplicationToOpenURL: () =>
						opener ? { isNil: () => false, path: opener } : { isNil: () => true },
				},
			},
			NSFileManager: { defaultManager: { fileExistsAtPath: (p: string) => existing.includes(p) } },
			NSURL: { fileURLWithPath: (p: string) => p },
		},
	};
	vm.runInNewContext(`${APP_HELPERS}\nresult = documentTarget(identity);`, sandbox);
	return sandbox.result === null ? null : (JSON.parse(JSON.stringify(sandbox.result)) as Doc);
}

const TEXTEDIT = "/System/Applications/TextEdit.app";

test("a file that exists and is not an app bundle is a document", () => {
	assert.deepEqual(documentTarget("/Users/x/notes.txt", ["/Users/x/notes.txt"], TEXTEDIT), {
		path: "/Users/x/notes.txt",
		name: "notes.txt",
		base: "notes",
		opener: TEXTEDIT,
	});

	// No extension, a leading dot, and several dots all still have a name.
	assert.equal(documentTarget("/Users/x/LICENSE", ["/Users/x/LICENSE"], TEXTEDIT)?.base, "LICENSE");
	assert.equal(documentTarget("/Users/x/.zshrc", ["/Users/x/.zshrc"], TEXTEDIT)?.base, ".zshrc");
	assert.equal(documentTarget("/Users/x/a.tar.gz", ["/Users/x/a.tar.gz"], TEXTEDIT)?.base, "a.tar");
});

test("an app, a bundle id, a Steam game and a missing file are not documents", () => {
	const exists = ["/Applications/Slack.app", "/Users/x/notes.txt"];

	assert.equal(documentTarget("/Applications/Slack.app", exists, TEXTEDIT), null);
	assert.equal(documentTarget("/Applications/Slack.app/", exists, TEXTEDIT), null);
	assert.equal(documentTarget("bundle:com.tinyspeck.slackmacgap", exists, TEXTEDIT), null);
	assert.equal(documentTarget("", exists, TEXTEDIT), null);
	// A document that has been moved away must fail as a missing file, not be
	// waited for.
	assert.equal(documentTarget("/Users/x/gone.txt", exists, TEXTEDIT), null);
	assert.equal(documentTarget("/Users/x/notes.txt", exists, TEXTEDIT, true), null, "a Steam key is a game");
});

test("a file nothing is registered to open is still a document, with no opener", () => {
	const doc = documentTarget("/Users/x/thing.zzz", ["/Users/x/thing.zzz"], null);
	assert.equal(doc?.name, "thing.zzz");
	assert.equal(doc?.opener, null);
});

/* --------------------------- script well-formedness ------------------------ */

const scripts: [string, string][] = [
	["launch (document, zone)", buildLaunchScript(launch())],
	["launch (document, no positioning)", buildLaunchScript(launch({ positionMode: "none" }))],
	["launch (document, minimized)", buildLaunchScript(launch({ positionMode: "minimize" }))],
	["launch (document, with filter)", buildLaunchScript(launch({ titleFilter: "Dashboard" }))],
	["capture (document)", buildCaptureScript(launch())],
	["icon (document)", buildAppIconScript("/Users/x/Documents/notes.txt")],
];

for (const [name, script] of scripts) {
	test(`the ${name} script is syntactically valid JavaScript`, () => {
		assert.doesNotThrow(() => new vm.Script(script));
	});
}

/* --------------------------------- behavior -------------------------------- */

test("a document is decided on before anything is assumed about an app", () => {
	const script = buildLaunchScript(launch());
	const decide = script.indexOf("if (doc) return launchDocument(doc);");
	const app = script.indexOf("var bundlePath = requireBundlePath(CFG.appPath);", decide);

	assert.ok(decide !== -1, "the launch script hands a document to its own path");
	assert.ok(app !== -1, "and resolves an app bundle only after that");
});

test("a document is opened with /usr/bin/open, as it is, and without the key's arguments", () => {
	const script = buildLaunchScript(launch({ launchArgs: "--flag" }));
	const helper = script.slice(
		script.indexOf("function launchDocument(doc)"),
		script.indexOf("function requireBundlePath("),
	);

	assert.ok(helper.includes("runTool('/usr/bin/open', args)"), "handed to open, never to an Apple Event");
	assert.ok(helper.includes("['-g', doc.path] : [doc.path]"), "the file itself is the only argument");
	assert.ok(!helper.includes("--args"), "arguments belong to a program");
});

test("a document that opens with nothing to position is a successful press", () => {
	const script = buildLaunchScript(launch({ positionMode: "none" }));
	const helper = script.slice(
		script.indexOf("function launchDocument(doc)"),
		script.indexOf("function requireBundlePath("),
	);
	const giveUp = helper.indexOf("if (!target && CFG.positionMode === 'none') {");
	const timeout = helper.indexOf("fail('Timed out waiting for a window showing");

	assert.ok(giveUp !== -1 && timeout !== -1 && giveUp < timeout);
});

test("a document's key takes its icon from the app that opens it", () => {
	const script = buildAppIconScript("/Users/x/Documents/notes.txt");
	assert.ok(script.includes("if (DOC) return DOC.opener;"));
	assert.ok(script.includes("has no app set up to open"), "and says so when there is none");
});
