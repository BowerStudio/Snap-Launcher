import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
	findSteamLaunchExecutables,
	launchExecutables,
	parseAppInfoLaunchEntries,
	type SteamLaunchEntry,
} from "../src/platform/steam-appinfo.ts";

/*
 * appinfo.vdf fixtures are written here, byte by byte, in each layout the
 * reader claims to understand — the same way the client writes them — so every
 * case states exactly what is in the file.
 */

type KV = { [key: string]: string | number | KV };

const MAGIC = { 27: 0x07564427, 28: 0x07564428, 29: 0x07564429 } as const;
type Version = keyof typeof MAGIC;

/** Binary KeyValues for one section, keys inline (v27/28) or by index (v29). */
function encodeKV(kv: KV, keyName: (key: string) => Buffer): Buffer {
	const parts: Buffer[] = [];
	for (const [key, value] of Object.entries(kv)) {
		if (typeof value === "string") {
			parts.push(Buffer.from([0x01]), keyName(key), Buffer.from(value + "\0", "utf8"));
		} else if (typeof value === "number") {
			const n = Buffer.alloc(4);
			n.writeInt32LE(value);
			parts.push(Buffer.from([0x02]), keyName(key), n);
		} else {
			parts.push(Buffer.from([0x00]), keyName(key), encodeKV(value, keyName));
		}
	}
	parts.push(Buffer.from([0x08]));
	return Buffer.concat(parts);
}

/** A whole appinfo.vdf holding the given apps. */
function appInfoFile(version: Version, apps: Record<number, KV>): Buffer {
	const strings: string[] = [];
	const keyName =
		version === 29
			? (key: string) => {
					let index = strings.indexOf(key);
					if (index < 0) {
						index = strings.push(key) - 1;
					}
					const b = Buffer.alloc(4);
					b.writeUInt32LE(index);
					return b;
				}
			: (key: string) => Buffer.from(key + "\0", "utf8");

	const records: Buffer[] = [];
	for (const [appId, kv] of Object.entries(apps)) {
		const data = Buffer.concat([
			Buffer.from([0x00]),
			keyName("appinfo"),
			encodeKV(kv, keyName),
			Buffer.from([0x08]),
		]);
		// infoState, lastUpdated, picsToken, text SHA-1, changeNumber, and
		// (v28+) binary SHA-1: none of them read, all of them skipped.
		const header = Buffer.alloc(version === 27 ? 40 : 60);
		const head = Buffer.alloc(8);
		head.writeUInt32LE(Number(appId), 0);
		head.writeUInt32LE(header.length + data.length, 4);
		records.push(head, header, data);
	}
	const end = Buffer.alloc(4); // appid 0 ends the records

	if (version !== 29) {
		const start = Buffer.alloc(8);
		start.writeUInt32LE(MAGIC[version], 0);
		start.writeUInt32LE(1, 4);
		return Buffer.concat([start, ...records, end]);
	}
	const body = Buffer.concat([...records, end]);
	const start = Buffer.alloc(16);
	start.writeUInt32LE(MAGIC[29], 0);
	start.writeUInt32LE(1, 4);
	start.writeBigInt64LE(BigInt(16 + body.length), 8);
	const count = Buffer.alloc(4);
	count.writeUInt32LE(strings.length);
	return Buffer.concat([start, body, count, ...strings.map((s) => Buffer.from(s + "\0", "utf8"))]);
}

/** The Division's launch config, as Steam records it. */
const DIVISION: KV = {
	common: { name: "Tom Clancy's The Division", type: "Game" },
	config: {
		installdir: "Tom Clancy's The Division",
		launch: {
			"0": { executable: "TheDivision.exe", type: "default", config: { oslist: "windows" } },
			"1": { executable: "TheDivision.exe", type: "default", description: "Free Weekend" },
		},
	},
};

const OTHER: KV = { common: { name: "Other" }, config: { launch: { "0": { executable: "other.exe" } } } };

for (const version of [27, 28, 29] as const) {
	test(`launch entries are read from a v${version} appinfo.vdf, other apps skipped`, () => {
		const file = appInfoFile(version, { 10: OTHER, 365590: DIVISION, 20: OTHER });
		assert.deepEqual(parseAppInfoLaunchEntries(file, "365590"), [
			{ index: 0, executable: "TheDivision.exe", type: "default", oslist: "windows", betaKey: "" },
			{ index: 1, executable: "TheDivision.exe", type: "default", oslist: "", betaKey: "" },
		]);
	});
}

test("an app with no launch config has no entries; an app not in the file is unknown", () => {
	const file = appInfoFile(29, { 10: { common: { name: "Tool" } } });
	assert.deepEqual(parseAppInfoLaunchEntries(file, "10"), []);
	assert.equal(parseAppInfoLaunchEntries(file, "11"), null);
});

test("a BetaKey is recognised whatever its case", () => {
	const file = appInfoFile(29, {
		1: { config: { launch: { "15": { executable: "bf6.exe", config: { BetaKey: "testbranch" } } } } },
	});
	assert.equal(parseAppInfoLaunchEntries(file, "1")?.[0].betaKey, "testbranch");
});

test("a file in an unknown layout, or a damaged one, is nothing recorded rather than an error", () => {
	const good = appInfoFile(29, { 365590: DIVISION });

	const newer = Buffer.from(good);
	newer.writeUInt32LE(0x0756442a, 0);
	assert.equal(parseAppInfoLaunchEntries(newer, "365590"), null, "a future version");

	assert.equal(parseAppInfoLaunchEntries(good.subarray(0, 40), "365590"), null, "truncated");
	assert.equal(parseAppInfoLaunchEntries(Buffer.alloc(0), "365590"), null, "empty");

	const oversized = Buffer.from(good);
	oversized.writeUInt32LE(0x7fffffff, 20);
	assert.equal(parseAppInfoLaunchEntries(oversized, "365590"), null, "a record larger than the file");

	const strange = appInfoFile(28, { 365590: DIVISION });
	strange[8 + 8 + 60] = 0x42; // the app's first KeyValues type byte
	assert.equal(parseAppInfoLaunchEntries(strange, "365590"), null, "an unknown value type");

	assert.equal(parseAppInfoLaunchEntries(good, "../1"), null, "a malformed app id");
});

/* --------------------------- choosing executables -------------------------- */

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** An install folder holding the given (empty) files. */
function installDir(files: string[]): string {
	const dir = mkdtempSync(path.join(tmpdir(), "snap-appinfo-"));
	dirs.push(dir);
	for (const file of files) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), "");
	}
	return dir;
}

const entry = (index: number, executable: string, extra: Partial<SteamLaunchEntry> = {}): SteamLaunchEntry => ({
	index,
	executable,
	type: "",
	oslist: "",
	betaKey: "",
	...extra,
});

test("the main branch's default entry comes first; beta-only ones follow; anti-cheat never", () => {
	// Battlefield 6: the public entry is EA's anti-cheat launcher, and bf6.exe
	// is recorded only for a test branch.
	const dir = installDir(["bf6.exe", "EAAntiCheat.GameServiceLauncher.exe", "Launcher.exe"]);
	const result = launchExecutables(
		[
			entry(0, "EAAntiCheat.GameServiceLauncher.exe"),
			entry(15, "bf6.exe", { type: "default", betaKey: "testbranch_mi" }),
			entry(20, "Launcher.exe", { type: "option1" }),
		],
		dir,
	);
	assert.deepEqual(result, [path.join(dir, "Launcher.exe"), path.join(dir, "bf6.exe")]);
});

test("entries for other systems, of type none, missing on disk, or outside the folder are dropped", () => {
	const dir = installDir(["Game.exe", "Other.exe", "bin/Tool.exe", "Game.app"]);
	const result = launchExecutables(
		[
			entry(0, "Game.app", { oslist: "macos" }),
			entry(1, "Missing.exe", { type: "default" }),
			entry(2, "..\\elsewhere.exe"),
			entry(3, "Other.exe", { type: "none" }),
			entry(4, "bin/Tool.exe", { oslist: "windows,linux" }),
			entry(5, "Game.exe", { type: "default" }),
			entry(6, "start_protected_game.exe"),
		],
		dir,
	);
	assert.deepEqual(result, [path.join(dir, "Game.exe"), path.join(dir, "bin", "Tool.exe")]);
});

test("findSteamLaunchExecutables reads the client's own file, trying each Steam root", () => {
	const game = installDir(["TheDivision.exe", "UbisoftConnectInstaller.exe"]);
	const empty = installDir([]);
	const steam = installDir([]);
	mkdirSync(path.join(steam, "appcache"));
	writeFileSync(path.join(steam, "appcache", "appinfo.vdf"), appInfoFile(29, { 365590: DIVISION }));

	assert.deepEqual(findSteamLaunchExecutables([empty, steam], "365590", game), [path.join(game, "TheDivision.exe")]);
	assert.deepEqual(findSteamLaunchExecutables([steam], "365590", ""), [], "not installed");
	assert.deepEqual(findSteamLaunchExecutables([empty], "365590", game), [], "no appinfo.vdf at all");
});
