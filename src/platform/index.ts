import type { PlatformBackend } from "./backend";
import { macosBackend } from "./macos";
import { windowsBackend } from "./windows";

export type { PlatformBackend, PlatformFeatures } from "./backend";
export * from "./types";

/**
 * Stand-in for a platform with no implementation. The plugin still loads and
 * its actions still appear — a user on an unsupported OS gets one legible
 * message per key press instead of a plugin that fails to connect.
 */
function unsupportedBackend(platform: string): PlatformBackend {
	const fail = (): Promise<never> =>
		Promise.reject(new Error(`Snap Launcher supports Windows and macOS; this is ${platform}.`));

	return {
		platform,
		features: { virtualDesktop: false },
		launch: fail,
		capture: fail,
		close: fail,
		listRunningApps: fail,
		listInstalledApps: fail,
		listSteamGames: fail,
		listMonitors: fail,
		findAppIcon: fail,
	};
}

/** Exported for tests; production callers use the memoised getBackend(). */
export function selectBackend(platform: string): PlatformBackend {
	switch (platform) {
		case "win32":
			return windowsBackend;
		case "darwin":
			return macosBackend;
		default:
			return unsupportedBackend(platform);
	}
}

let cached: PlatformBackend | undefined;

/** The backend for the OS this plugin is running on. Resolved once. */
export function getBackend(): PlatformBackend {
	if (cached === undefined) {
		cached = selectBackend(process.platform);
	}
	return cached;
}
