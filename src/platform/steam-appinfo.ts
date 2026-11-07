import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The executables Steam itself starts for a game, read out of the client's own
 * metadata cache.
 *
 * A game's appmanifest records where it is installed, but not what to run.
 * That lives in appcache/appinfo.vdf, the client's cache of every app's store
 * metadata, under config/launch: the very entries the Play button picks from.
 * It is the one place a game's executable is recorded by name — thedivision.exe
 * and ROA2.exe are not guessable from "Tom Clancy's The Division" and "Rock of
 * Ages 2".
 *
 * The file is binary and undocumented. Its layout is well known from the
 * community tools that read it, but Valve has changed it more than once, so
 * this recognises exactly the layouts it was written against and treats
 * anything else — a newer version, a truncated file, a value type never seen
 * before — as "nothing recorded". Every caller already has a fallback; a Steam
 * update must never be able to do worse than that.
 */

/** One config/launch entry: a way Steam can start the game. */
export type SteamLaunchEntry = {
	/** The entry's numeric key — Steam's own order of the options. */
	index: number;
	/** Path of what is started, relative to the install directory, as Steam stores it. */
	executable: string;
	/** "default", "option1", "none", "vr"…; "" when unset. */
	type: string;
	/** Comma-separated OS list, e.g. "windows"; "" means every OS. */
	oslist: string;
	/** The beta branch the entry is limited to; "" for the main branch. */
	betaKey: string;
};

/**
 * Format versions this reader understands, by the magic number that opens the
 * file. Each adds to the one before: 28 a binary SHA-1 in every app's header,
 * 29 a shared string table that key names index into instead of repeating.
 */
const V27 = 0x07564427;
const V28 = 0x07564428;
const V29 = 0x07564429;

/**
 * Launch entries that start an anti-cheat service rather than the game. Steam
 * runs them because the game requires it, but their icon is the anti-cheat
 * vendor's — Battlefield 6's launch entry shows EA's logo — so they say nothing
 * about what the game looks like.
 */
const ANTI_CHEAT_WRAPPERS = [/anti-?cheat/i, /^start_protected_game\.exe$/i];

/**
 * The config/launch entries recorded for one app, or null when the file is not
 * a layout this reader knows, is damaged, or has no record of the app.
 */
export function parseAppInfoLaunchEntries(file: Buffer, appId: string): SteamLaunchEntry[] | null {
	const wanted = Number(appId);
	if (!/^\d+$/.test(appId) || !Number.isSafeInteger(wanted)) {
		return null;
	}
	try {
		const reader = AppInfoReader.open(file);
		const kv = reader?.findApp(wanted);
		if (!kv) {
			return null;
		}
		const launch = child(child(child(kv, "appinfo"), "config"), "launch");
		if (!launch) {
			return [];
		}
		const entries: SteamLaunchEntry[] = [];
		for (const [key, value] of Object.entries(launch)) {
			if (!/^\d+$/.test(key) || !isSection(value)) {
				continue;
			}
			const executable = text(value, "executable");
			if (!executable) {
				continue;
			}
			const config = child(value, "config");
			entries.push({
				index: Number(key),
				executable,
				type: text(value, "type").toLowerCase(),
				oslist: config ? text(config, "oslist").toLowerCase() : "",
				betaKey: config ? text(config, "betakey") : "",
			});
		}
		return entries.sort((a, b) => a.index - b.index);
	} catch {
		// Any read past the end, or a structure that doesn't hold together, is
		// a file this reader doesn't understand.
		return null;
	}
}

/**
 * Absolute paths of the executables Steam starts a game with on Windows, best
 * first, keeping only ones that exist inside the install directory.
 *
 * The main branch's default entry comes first, as it is what Play runs. Entries
 * limited to a beta branch follow rather than being dropped: Battlefield 6
 * records bf6.exe only on a test branch, its public entry being the anti-cheat
 * launcher, and the game's own exe is still the better icon. Anti-cheat
 * launchers and entries marked "none" are left out altogether.
 */
export function findSteamLaunchExecutables(steamRoots: readonly string[], appId: string, installDir: string): string[] {
	if (!installDir) {
		return [];
	}
	for (const root of steamRoots) {
		let file: Buffer;
		try {
			file = readFileSync(path.join(root, "appcache", "appinfo.vdf"));
		} catch {
			continue;
		}
		const entries = parseAppInfoLaunchEntries(file, appId);
		if (entries) {
			return launchExecutables(entries, installDir);
		}
	}
	return [];
}

/** Orders and resolves launch entries; separated from file I/O for tests. */
export function launchExecutables(entries: readonly SteamLaunchEntry[], installDir: string): string[] {
	const root = path.resolve(installDir);
	const ranked = entries
		.filter((e) => runsOnWindows(e) && e.type !== "none" && !isAntiCheat(e.executable))
		.map((e) => ({ e, rank: (e.betaKey ? 2 : 0) + (e.type === "default" ? 0 : 1) }))
		.sort((a, b) => a.rank - b.rank || a.e.index - b.e.index);

	const seen = new Set<string>();
	const paths: string[] = [];
	for (const { e } of ranked) {
		const resolved = resolveInside(root, e.executable);
		if (!resolved || !/\.exe$/i.test(resolved) || seen.has(resolved.toLowerCase())) {
			continue;
		}
		seen.add(resolved.toLowerCase());
		if (isFile(resolved)) {
			paths.push(resolved);
		}
	}
	return paths;
}

function runsOnWindows(entry: SteamLaunchEntry): boolean {
	return !entry.oslist || entry.oslist.split(",").some((os) => os.trim() === "windows");
}

function isAntiCheat(executable: string): boolean {
	const name = path.win32.basename(executable);
	return ANTI_CHEAT_WRAPPERS.some((pattern) => pattern.test(name));
}

/**
 * The executable's absolute path, or null when it would land outside the
 * install directory. Steam stores it relative to that directory, in either
 * slash style, occasionally quoted or with a leading ".\".
 */
function resolveInside(root: string, executable: string): string | null {
	const relative = executable
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.replace(/[\\/]+/g, path.sep);
	if (!relative || path.isAbsolute(relative)) {
		return null;
	}
	const resolved = path.resolve(root, relative);
	return resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep) ? resolved : null;
}

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/* ------------------------------ binary format ------------------------------ */

type KVValue = string | number | KVSection;
type KVSection = { [key: string]: KVValue };

function isSection(value: KVValue | undefined): value is KVSection {
	return typeof value === "object" && value !== null;
}

/** A sub-section by key, ignoring case: Steam writes "BetaKey" and "betakey" alike. */
function child(section: KVSection | null | undefined, key: string): KVSection | null {
	const value = lookup(section, key);
	return isSection(value) ? value : null;
}

function text(section: KVSection, key: string): string {
	const value = lookup(section, key);
	return typeof value === "string" ? value.trim() : "";
}

function lookup(section: KVSection | null | undefined, key: string): KVValue | undefined {
	if (!section) {
		return undefined;
	}
	if (key in section) {
		return section[key];
	}
	const lower = key.toLowerCase();
	const match = Object.keys(section).find((k) => k.toLowerCase() === lower);
	return match === undefined ? undefined : section[match];
}

/**
 * Walks appinfo.vdf. Every app is a fixed header followed by its data as
 * binary KeyValues; the header carries the data's size, so apps other than the
 * one wanted are skipped without being decoded.
 */
class AppInfoReader {
	private readonly file: Buffer;
	/** Bytes between an app's size field and its KeyValues. */
	private readonly headerSize: number;
	/** Where the app records end: the string table (v29) or the file's end. */
	private readonly end: number;
	/** Key names, for v29; empty when keys are stored inline. */
	private readonly strings: string[];
	private readonly firstApp: number;

	private constructor(file: Buffer, headerSize: number, end: number, strings: string[], firstApp: number) {
		this.file = file;
		this.headerSize = headerSize;
		this.end = end;
		this.strings = strings;
		this.firstApp = firstApp;
	}

	static open(file: Buffer): AppInfoReader | null {
		if (file.length < 8) {
			return null;
		}
		const magic = file.readUInt32LE(0);
		if (magic === V27 || magic === V28) {
			return new AppInfoReader(file, magic === V27 ? 40 : 60, file.length, [], 8);
		}
		if (magic !== V29) {
			return null;
		}
		const tableOffset = Number(file.readBigInt64LE(8));
		if (!Number.isSafeInteger(tableOffset) || tableOffset < 16 || tableOffset + 4 > file.length) {
			return null;
		}
		const count = file.readUInt32LE(tableOffset);
		const strings: string[] = [];
		let pos = tableOffset + 4;
		for (let i = 0; i < count; i++) {
			const [value, next] = cString(file, pos, file.length);
			strings.push(value);
			pos = next;
		}
		return new AppInfoReader(file, 60, tableOffset, strings, 16);
	}

	/** The app's decoded KeyValues, or null when it isn't in the file. */
	findApp(appId: number): KVSection | null {
		let pos = this.firstApp;
		while (pos + 8 <= this.end) {
			const id = this.file.readUInt32LE(pos);
			if (id === 0) {
				return null;
			}
			const size = this.file.readUInt32LE(pos + 4);
			const next = pos + 8 + size;
			if (size < this.headerSize || next > this.end) {
				throw new Error("App record overruns the file.");
			}
			if (id === appId) {
				return this.section(pos + 8 + this.headerSize, next)[0];
			}
			pos = next;
		}
		return null;
	}

	/** Decodes one KeyValues section, returning it and where it ended. */
	private section(start: number, limit: number, depth = 0): [KVSection, number] {
		if (depth > 32) {
			throw new Error("KeyValues nested implausibly deep.");
		}
		const out: KVSection = {};
		let pos = start;
		for (;;) {
			if (pos >= limit) {
				throw new Error("KeyValues section is not terminated.");
			}
			const type = this.file[pos++];
			if (type === 0x08 || type === 0x0b) {
				return [out, pos];
			}
			let key: string;
			if (this.strings.length) {
				const index = this.file.readUInt32LE(pos);
				pos += 4;
				if (index >= this.strings.length) {
					throw new Error("Key name index is out of range.");
				}
				key = this.strings[index];
			} else {
				[key, pos] = cString(this.file, pos, limit);
			}
			switch (type) {
				case 0x00: {
					const [value, next] = this.section(pos, limit, depth + 1);
					out[key] = value;
					pos = next;
					break;
				}
				case 0x01: {
					const [value, next] = cString(this.file, pos, limit);
					out[key] = value;
					pos = next;
					break;
				}
				case 0x02: // int32
				case 0x04: // pointer
				case 0x06: // colour
					out[key] = this.file.readInt32LE(pos);
					pos += 4;
					break;
				case 0x03:
					out[key] = this.file.readFloatLE(pos);
					pos += 4;
					break;
				case 0x07: // uint64
				case 0x0a: // int64
					out[key] = Number(this.file.readBigUInt64LE(pos));
					pos += 8;
					break;
				default:
					throw new Error(`Unknown KeyValues type ${type}.`);
			}
		}
	}
}

/** A NUL-terminated UTF-8 string starting at pos, and the offset just past it. */
function cString(file: Buffer, pos: number, limit: number): [string, number] {
	const end = file.indexOf(0, pos);
	if (end < 0 || end >= limit) {
		throw new Error("String is not terminated.");
	}
	return [file.toString("utf8", pos, end), end + 1];
}
