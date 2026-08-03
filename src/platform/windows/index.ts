import path from "node:path";

import type { PlatformBackend } from "../backend";
import { toAppIconResult, type RawAppIcon } from "../icons";
import { listSteamGames, parseSteamAppId, resolveSteamTarget } from "../steam";
import type {
	AppIconResult,
	CaptureResult,
	CloseConfig,
	CloseResult,
	InstalledApp,
	LaunchConfig,
	LaunchResult,
	MonitorEntry,
	RunningApp,
	SteamTarget,
} from "../types";
import {
	buildAppIconScript,
	buildCaptureScript,
	buildCloseScript,
	buildInstalledListScript,
	buildLaunchScript,
	buildListScript,
	buildMonitorListScript,
	buildSteamPathScript,
	runPowerShell,
} from "./powershell";

/** Headroom over an operation's own waiting, for interpreter startup and interop. */
const OVERHEAD_MS = 20_000;

/** The monitor script predates MonitorEntry.index and does not emit it. */
type RawMonitor = Omit<MonitorEntry, "index">;

/**
 * Derives the 1-based arrangement position from a Windows device name
 * ("\\.\DISPLAY2" -> 2). deviceName itself is left byte-identical: it is
 * persisted as a key's monitorId, so rewriting it would orphan saved settings.
 * Device names without a trailing number keep their enumeration order.
 */
function displayIndex(deviceName: string, fallback: number): number {
	const n = /(\d+)$/.exec(deviceName)?.[1];
	return n ? Number(n) : fallback;
}

/**
 * Steam's install location as recorded in the registry, looked up once.
 *
 * Memoised because it cannot change while the plugin is running, and because
 * every Steam key press would otherwise pay for a second PowerShell process on
 * top of the one doing the actual work. Only a successful lookup is cached: a
 * machine that gains Steam later gets it on the next press.
 */
let registrySteamPaths: string[] | undefined;

async function steamRoots(): Promise<string[]> {
	if (registrySteamPaths === undefined) {
		try {
			const result = await runPowerShell<{ ok: boolean; paths?: string[] }>(buildSteamPathScript(), OVERHEAD_MS);
			if (result?.ok && Array.isArray(result.paths)) {
				registrySteamPaths = result.paths.filter((p) => typeof p === "string" && p.length > 0);
			}
		} catch {
			// Retried next time; the default locations below still apply.
		}
	}

	// Default install locations, for a machine whose registry could not be read
	// (and as a second chance when the recorded path is stale).
	const defaults = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
		.filter((dir): dir is string => typeof dir === "string" && dir.length > 0)
		.map((dir) => path.join(dir, "Steam"));

	return [...(registrySteamPaths ?? []), ...defaults];
}

/** The resolved Steam game for a config's appPath, or null for ordinary apps. */
async function steamTarget(config: LaunchConfig | CloseConfig): Promise<SteamTarget | null> {
	// Tested before the roots are looked up: resolving them can cost a
	// PowerShell process, and an ordinary key must not pay for one.
	if (!parseSteamAppId(config.appPath)) {
		return null;
	}
	const launchArgs = "launchArgs" in config ? config.launchArgs : "";
	return resolveSteamTarget(await steamRoots(), config.appPath, launchArgs);
}

/**
 * Windows backend: every operation is one PowerShell process emitting a single
 * JSON line. Behavior is exactly what the plugin did before the platform
 * abstraction existed — only the timeout arithmetic moved here from the actions.
 */
export const windowsBackend: PlatformBackend = {
	platform: "win32",
	features: { virtualDesktop: true },

	async launch(config: LaunchConfig): Promise<LaunchResult> {
		const steam = await steamTarget(config);
		return runPowerShell<LaunchResult>(buildLaunchScript(config, steam), config.waitSeconds * 1000 + OVERHEAD_MS);
	},

	async capture(config: LaunchConfig): Promise<CaptureResult> {
		return runPowerShell<CaptureResult>(buildCaptureScript(config, await steamTarget(config)), OVERHEAD_MS);
	},

	async close(config: CloseConfig): Promise<CloseResult> {
		const steam = await steamTarget(config);
		// closeThenKill spends up to waitSeconds waiting before force-quitting.
		const grace = config.closeMode === "closeThenKill" ? config.waitSeconds * 1000 : 0;
		return runPowerShell<CloseResult>(buildCloseScript(config, steam), grace + OVERHEAD_MS);
	},

	listRunningApps(): Promise<RunningApp[]> {
		return runPowerShell<RunningApp[]>(buildListScript(), OVERHEAD_MS);
	},

	listInstalledApps(): Promise<InstalledApp[]> {
		// Walking both Start Menu trees is slower than the other operations.
		return runPowerShell<InstalledApp[]>(buildInstalledListScript(), 30_000);
	},

	async listSteamGames(): Promise<InstalledApp[]> {
		// Reading Steam's manifests is ordinary file I/O, so this needs no
		// PowerShell of its own beyond the one registry lookup.
		return listSteamGames(await steamRoots()).map(({ name, path: value }) => ({ name, path: value }));
	},

	async listMonitors(): Promise<MonitorEntry[]> {
		const raw = await runPowerShell<RawMonitor[]>(buildMonitorListScript(), OVERHEAD_MS);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.map((m, i) => ({ ...m, index: displayIndex(m.deviceName, i + 1) }));
	},

	async findAppIcon(appPath: string): Promise<AppIconResult> {
		// A game's icon is looked for in its install directory, so the same
		// Steam resolution the other operations do is needed here too.
		const steam = parseSteamAppId(appPath) ? resolveSteamTarget(await steamRoots(), appPath) : null;
		// Searching a folder tree is closer to the installed-apps scan than to
		// the quick window operations, so it gets the same allowance.
		const raw = await runPowerShell<RawAppIcon>(buildAppIconScript(appPath, steam), 30_000);
		return toAppIconResult(raw);
	},
};
