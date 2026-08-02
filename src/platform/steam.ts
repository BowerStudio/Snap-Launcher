import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { SteamTarget } from "./types";

/**
 * Steam games as a launch target.
 *
 * A key stores `steam:<appid>`. The app id is Steam's own identifier: it
 * survives the game being updated, verified, or moved to another library
 * folder, none of which an executable path does. Games are started through the
 * `steam://` protocol rather than by running their exe, because that is what
 * pressing Play does — Steam starts its client first when it isn't running,
 * applies the game's launch options, and initialises the overlay and DRM that
 * many games refuse to run without.
 *
 * Everything below is plain filesystem work over Steam's own metadata, so it is
 * identical on Windows and macOS. Only *where* Steam itself is installed
 * differs, and that is each backend's business.
 */

const STEAM_PREFIX = "steam:";

/**
 * Entries that live in a library folder and carry an appmanifest exactly like a
 * game, but are runtimes shipped alongside one. Offering them on a key would
 * only ever produce a press that does nothing.
 */
const NON_GAME_APP_IDS = new Set(["228980"]);
const NON_GAME_NAMES = [/^steamworks common/i, /^steam linux runtime/i, /^proton(\s|$)/i];

/** One installed game: an app-picker entry plus where its files actually are. */
export type SteamGame = {
	/** Steam's own application id, digits only. */
	appId: string;
	/** The game's name as Steam records it. */
	name: string;
	/** The identity stored in a key's appPath. */
	path: string;
	/** Absolute directory the game's files live in, or "" when not on disk. */
	installDir: string;
};

/** The three fields Snap Launcher reads out of an `appmanifest_<appid>.acf`. */
export type SteamManifest = { appId: string; name: string; installDir: string };

/** Builds the stored identity for a Steam game. */
export function steamIdentity(appId: string): string {
	return `${STEAM_PREFIX}${appId}`;
}

/**
 * The app id carried by a `steam:<appid>` identity, or null for anything else —
 * which is how every caller tells a Steam key from an ordinary one.
 */
export function parseSteamAppId(identity: string): string | null {
	const value = (identity ?? "").trim();
	if (!value.toLowerCase().startsWith(STEAM_PREFIX)) {
		return null;
	}
	const appId = value.slice(STEAM_PREFIX.length).trim();
	return /^\d+$/.test(appId) ? appId : null;
}

/**
 * The `steam://` URL that starts a game.
 *
 * rungameid is the form Steam's own desktop shortcuts use, and the only one
 * that also covers games needing the client launched first. Arguments ride in
 * Steam's `//<args>` suffix, percent-encoded — they reach the game on top of
 * whatever launch options are configured in Steam itself.
 */
export function steamLaunchUrl(appId: string, launchArgs = ""): string {
	const args = (launchArgs ?? "").trim();
	const url = `steam://rungameid/${appId}`;
	return args ? `${url}//${encodeURIComponent(args)}` : url;
}

/**
 * Library folder paths from a `libraryfolders.vdf`.
 *
 * VDF is a nested key/value format, but the only keys named "path" in this file
 * are the library entries themselves, so they are read directly rather than
 * implementing the whole grammar. Values escape backslashes ("D:\\Games"),
 * which is undone here.
 */
export function parseLibraryPaths(vdf: string): string[] {
	const paths: string[] = [];
	const entry = /"path"\s*"((?:\\.|[^"\\])*)"/gi;
	let match: RegExpExecArray | null;
	while ((match = entry.exec(vdf)) !== null) {
		const value = unescapeVdf(match[1]);
		if (value) {
			paths.push(value);
		}
	}
	return paths;
}

/**
 * The fields Snap Launcher needs from an `appmanifest_<appid>.acf`. Each key is
 * taken at its first occurrence, which is its top-level AppState entry — the
 * nested blocks that could repeat a key (InstalledDepots, UserConfig) all come
 * after them. A manifest with no installdir describes something not yet on
 * disk, and is rejected.
 */
export function parseAppManifest(acf: string): SteamManifest | null {
	const appId = vdfValue(acf, "appid");
	const installDir = vdfValue(acf, "installdir");
	if (!/^\d+$/.test(appId) || !installDir) {
		return null;
	}
	// Nameless manifests are rare but real; the folder name is the better of
	// the two remaining options for a key title.
	return { appId, name: vdfValue(acf, "name") || installDir, installDir };
}

/**
 * Every game installed in the given Steam installations, sorted by name.
 *
 * A Steam installation owns a `steamapps` folder and lists any further library
 * folders in `libraryfolders.vdf`; a game's manifest lives in the library it
 * was installed into. Games whose files are not on disk are left out — they
 * cannot be launched without a download, and their windows could never be
 * matched.
 */
export function listSteamGames(steamRoots: readonly string[]): SteamGame[] {
	const games = new Map<string, SteamGame>();

	for (const library of libraryFolders(steamRoots)) {
		for (const game of gamesInLibrary(library)) {
			// The same game can be manifested in two libraries after a move;
			// the first one with files on disk wins.
			if (!games.has(game.appId)) {
				games.set(game.appId, game);
			}
		}
	}

	return [...games.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Looks up one game by app id, without reading every other manifest. */
export function findSteamGame(steamRoots: readonly string[], appId: string): SteamGame | null {
	for (const library of libraryFolders(steamRoots)) {
		const acf = readTextFile(path.join(library, "steamapps", `appmanifest_${appId}.acf`));
		if (!acf) {
			continue;
		}
		const manifest = parseAppManifest(acf);
		if (manifest) {
			return toGame(library, manifest);
		}
	}
	return null;
}

/**
 * Resolves a key's appPath into everything the platform scripts need to launch
 * a game and recognize its windows, or null when the key isn't a Steam one.
 *
 * Resolution itself never fails: a game that is not installed — uninstalled
 * since the key was set up, or restored onto a different machine — simply comes
 * back with no install directory, and the scripts turn that into a message
 * naming the game. What is never returned is a target the caller then has to
 * second-guess.
 */
export function resolveSteamTarget(
	steamRoots: readonly string[],
	identity: string,
	launchArgs = "",
): SteamTarget | null {
	const appId = parseSteamAppId(identity);
	if (!appId) {
		return null;
	}

	const game = findSteamGame(steamRoots, appId);
	return {
		appId,
		name: game?.name ?? `Steam app ${appId}`,
		installDir: game?.installDir ?? "",
		launchUrl: steamLaunchUrl(appId, launchArgs),
	};
}

/** Every library folder of every given installation, in order, deduplicated. */
function libraryFolders(steamRoots: readonly string[]): string[] {
	const seen = new Set<string>();
	const folders: string[] = [];

	const add = (dir: string): void => {
		// Steam writes its own path in whatever case and slash style it was
		// installed with; comparing resolved paths keeps a library from being
		// walked twice.
		const resolved = path.resolve(dir);
		const key = resolved.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			folders.push(resolved);
		}
	};

	for (const root of steamRoots) {
		if (!root) {
			continue;
		}
		add(root);
		const vdf = readTextFile(path.join(root, "steamapps", "libraryfolders.vdf"));
		for (const library of parseLibraryPaths(vdf)) {
			add(library);
		}
	}

	return folders;
}

/** The installed games manifested in one library folder. */
function gamesInLibrary(library: string): SteamGame[] {
	const steamapps = path.join(library, "steamapps");

	let entries: string[];
	try {
		entries = readdirSync(steamapps);
	} catch {
		// A library folder listed in the VDF but no longer mounted.
		return [];
	}

	const games: SteamGame[] = [];
	for (const entry of entries) {
		if (!/^appmanifest_\d+\.acf$/i.test(entry)) {
			continue;
		}
		const manifest = parseAppManifest(readTextFile(path.join(steamapps, entry)));
		if (!manifest || !isGame(manifest)) {
			continue;
		}
		const game = toGame(library, manifest);
		if (game.installDir) {
			games.push(game);
		}
	}
	return games;
}

/** Pairs a manifest with its library; installDir is "" when nothing is on disk. */
function toGame(library: string, manifest: SteamManifest): SteamGame {
	const installDir = path.join(library, "steamapps", "common", manifest.installDir);
	return {
		appId: manifest.appId,
		name: manifest.name,
		path: steamIdentity(manifest.appId),
		installDir: existsSync(installDir) ? installDir : "",
	};
}

function isGame(manifest: SteamManifest): boolean {
	return !NON_GAME_APP_IDS.has(manifest.appId) && !NON_GAME_NAMES.some((pattern) => pattern.test(manifest.name));
}

/** First value of a VDF key, unescaped; "" when the key is absent. */
function vdfValue(text: string, key: string): string {
	const match = new RegExp(`"${key}"\\s*"((?:\\\\.|[^"\\\\])*)"`, "i").exec(text);
	return match ? unescapeVdf(match[1]) : "";
}

function unescapeVdf(value: string): string {
	return value.replace(/\\(.)/g, "$1").trim();
}

/** Reads a file, or "" for anything that isn't a readable file. */
function readTextFile(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}
