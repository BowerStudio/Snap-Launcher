import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
	findSteamGame,
	listSteamGames,
	parseAppManifest,
	parseLibraryPaths,
	parseSteamAppId,
	resolveSteamTarget,
	steamIdentity,
	steamLaunchUrl,
} from "../src/platform/steam.ts";

/* ----------------------------- identity & URL ----------------------------- */

test("a Steam identity round-trips, and nothing else parses as one", () => {
	assert.equal(steamIdentity("1361210"), "steam:1361210");
	assert.equal(parseSteamAppId("steam:1361210"), "1361210");
	assert.equal(parseSteamAppId("  steam:1361210  "), "1361210", "settings values arrive trimmed, but be forgiving");
	assert.equal(parseSteamAppId("STEAM:1361210"), "1361210", "the prefix is matched case-insensitively");

	// Every other identity shape the plugin stores must not be mistaken for one.
	for (const other of ["", "C:\\Games\\game.exe", "bundle:com.valvesoftware.steam", "shell:AppsFolder\\Foo!App", "steam:", "steam:abc"]) {
		assert.equal(parseSteamAppId(other), null, other);
	}
});

test("the launch URL is Steam's own shortcut form, with arguments appended", () => {
	assert.equal(steamLaunchUrl("1361210"), "steam://rungameid/1361210");
	assert.equal(steamLaunchUrl("1361210", "   "), "steam://rungameid/1361210", "whitespace is not an argument");
	// Percent-encoded: the arguments are a path segment of a URL, not a shell command.
	assert.equal(steamLaunchUrl("440", "-novid -high"), "steam://rungameid/440//-novid%20-high");
});

/* -------------------------------- parsing --------------------------------- */

test("library folders are read out of libraryfolders.vdf", () => {
	const vdf = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"158096553"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"label"		""
	}
}`;

	assert.deepEqual(parseLibraryPaths(vdf), ["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]);
});

test("an empty or unrecognisable vdf yields no libraries rather than throwing", () => {
	assert.deepEqual(parseLibraryPaths(""), []);
	assert.deepEqual(parseLibraryPaths("not a vdf at all"), []);
});

test("an app manifest yields the app id, name and install folder", () => {
	const acf = `"AppState"
{
	"appid"		"1361210"
	"universe"		"1"
	"LauncherPath"		"C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe"
	"name"		"Warhammer 40,000: Darktide"
	"StateFlags"		"4"
	"installdir"		"Warhammer 40,000 DARKTIDE"
	"InstalledDepots"
	{
		"1361211"
		{
			"manifest"		"123"
			"name"		"a nested key that must not win"
		}
	}
}`;

	assert.deepEqual(parseAppManifest(acf), {
		appId: "1361210",
		name: "Warhammer 40,000: Darktide",
		installDir: "Warhammer 40,000 DARKTIDE",
	});
});

test("a manifest missing what a launch needs is rejected", () => {
	assert.equal(parseAppManifest(""), null);
	assert.equal(parseAppManifest('"AppState" { "appid" "12" }'), null, "no installdir: nothing is on disk yet");
	assert.equal(parseAppManifest('"AppState" { "installdir" "Game" }'), null, "no appid: nothing to launch");
});

test("a nameless manifest falls back to its folder name", () => {
	assert.deepEqual(parseAppManifest('"AppState" { "appid" "7" "installdir" "Some Game" }'), {
		appId: "7",
		name: "Some Game",
		installDir: "Some Game",
	});
});

/* ------------------------- discovery over real files ----------------------- */

const roots: string[] = [];

after(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true });
	}
});

type FakeGame = { appId: string; name: string; installDir: string; onDisk?: boolean };

/** Writes a Steam installation and its extra library folder to a temp tree. */
function fakeSteam(main: FakeGame[], extra: FakeGame[] = []): { steamRoot: string; libraryRoot: string } {
	const root = mkdtempSync(path.join(tmpdir(), "snap-steam-"));
	roots.push(root);

	const steamRoot = path.join(root, "Steam");
	const libraryRoot = path.join(root, "SteamLibrary");

	for (const [library, games] of [
		[steamRoot, main],
		[libraryRoot, extra],
	] as const) {
		const steamapps = path.join(library, "steamapps");
		mkdirSync(steamapps, { recursive: true });
		for (const game of games) {
			writeFileSync(
				path.join(steamapps, `appmanifest_${game.appId}.acf`),
				`"AppState"\n{\n\t"appid"\t\t"${game.appId}"\n\t"name"\t\t"${game.name}"\n\t"installdir"\t\t"${game.installDir}"\n}\n`,
			);
			if (game.onDisk !== false) {
				mkdirSync(path.join(steamapps, "common", game.installDir), { recursive: true });
			}
		}
	}

	// Steam records every library, its own included, with escaped backslashes.
	const escaped = (p: string): string => p.replace(/\\/g, "\\\\");
	writeFileSync(
		path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
		`"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${escaped(steamRoot)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${escaped(libraryRoot)}"\n\t}\n}\n`,
	);

	return { steamRoot, libraryRoot };
}

test("games are listed across every library folder, sorted by name", () => {
	const { steamRoot, libraryRoot } = fakeSteam(
		[{ appId: "10", name: "Zeta Protocol", installDir: "Zeta" }],
		[
			{ appId: "20", name: "Alpha Strike", installDir: "Alpha" },
			{ appId: "30", name: "Mid Game", installDir: "Mid" },
		],
	);

	const games = listSteamGames([steamRoot]);

	assert.deepEqual(
		games.map((g) => g.name),
		["Alpha Strike", "Mid Game", "Zeta Protocol"],
	);
	assert.deepEqual(
		games.map((g) => g.path),
		["steam:20", "steam:30", "steam:10"],
		"every entry is stored by app id, not by path",
	);
	assert.equal(games[0].installDir, path.join(libraryRoot, "steamapps", "common", "Alpha"));
});

test("runtimes that are installed like games are not offered as games", () => {
	const { steamRoot } = fakeSteam([
		{ appId: "228980", name: "Steamworks Common Redistributables", installDir: "Steamworks Shared" },
		{ appId: "1493710", name: "Proton Experimental", installDir: "Proton - Experimental" },
		{ appId: "1391110", name: "Steam Linux Runtime 2.0 (soldier)", installDir: "SteamLinuxRuntime_soldier" },
		{ appId: "40", name: "A Real Game", installDir: "Real" },
	]);

	assert.deepEqual(
		listSteamGames([steamRoot]).map((g) => g.name),
		["A Real Game"],
	);
});

test("a manifest whose files are not on disk is left out of the list", () => {
	const { steamRoot } = fakeSteam([
		{ appId: "50", name: "Installed", installDir: "Here" },
		{ appId: "60", name: "Queued For Download", installDir: "NotHere", onDisk: false },
	]);

	assert.deepEqual(
		listSteamGames([steamRoot]).map((g) => g.name),
		["Installed"],
	);
});

test("a game manifested in two libraries is offered once", () => {
	const { steamRoot } = fakeSteam(
		[{ appId: "70", name: "Moved Game", installDir: "Moved" }],
		[{ appId: "70", name: "Moved Game", installDir: "Moved" }],
	);

	assert.equal(listSteamGames([steamRoot]).length, 1);
});

test("no Steam installation yields no games rather than an error", () => {
	assert.deepEqual(listSteamGames([]), []);
	assert.deepEqual(listSteamGames([path.join(tmpdir(), "snap-steam-does-not-exist")]), []);
});

test("a key resolves to the game's install directory and launch URL", () => {
	const { steamRoot, libraryRoot } = fakeSteam([], [{ appId: "1361210", name: "Darktide", installDir: "Darktide Dir" }]);

	const target = resolveSteamTarget([steamRoot], "steam:1361210", "-novid");

	assert.equal(target?.appId, "1361210");
	assert.equal(target?.name, "Darktide");
	assert.equal(target?.installDir, path.join(libraryRoot, "steamapps", "common", "Darktide Dir"));
	assert.equal(target?.launchUrl, "steam://rungameid/1361210//-novid");
});

test("an uninstalled game resolves without an install directory, never to null", () => {
	const { steamRoot } = fakeSteam([{ appId: "80", name: "Gone", installDir: "Gone", onDisk: false }]);

	// The scripts turn the empty directory into a message naming the game; what
	// they must not get is a target they have to second-guess.
	const known = resolveSteamTarget([steamRoot], "steam:80");
	assert.equal(known?.name, "Gone");
	assert.equal(known?.installDir, "", "with no files there is nothing to match windows against");
	assert.equal(known?.launchUrl, "steam://rungameid/80");

	// A game that isn't manifested at all is still launchable by id.
	const unknown = resolveSteamTarget([steamRoot], "steam:999999");
	assert.equal(unknown?.installDir, "");
	assert.equal(unknown?.launchUrl, "steam://rungameid/999999");
	assert.match(unknown?.name ?? "", /999999/, "the message has to name something");
});

test("an ordinary app path resolves to no Steam target at all", () => {
	const { steamRoot } = fakeSteam([{ appId: "90", name: "Game", installDir: "Game" }]);

	assert.equal(resolveSteamTarget([steamRoot], "C:\\Program Files\\App\\app.exe"), null);
	assert.equal(resolveSteamTarget([steamRoot], "bundle:com.apple.Safari"), null);
});

test("findSteamGame reads one manifest instead of the whole library", () => {
	const { steamRoot, libraryRoot } = fakeSteam(
		[{ appId: "100", name: "First", installDir: "First" }],
		[{ appId: "110", name: "Second", installDir: "Second" }],
	);

	assert.equal(findSteamGame([steamRoot], "110")?.installDir, path.join(libraryRoot, "steamapps", "common", "Second"));
	assert.equal(findSteamGame([steamRoot], "120"), null);
});
