import { homedir } from "node:os";
import path from "node:path";

import type { PlatformBackend } from "../backend";
import { toAppIconResult, type RawAppIcon } from "../icons";
import { listSteamGames, resolveSteamTarget } from "../steam";
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
import { buildInstalledListScript, buildRunningListScript } from "./apps";
import { buildDisplayListScript, toMonitorEntries, type RawScreen } from "./displays";
import { buildAppIconScript } from "./icons";
import { runOsascript } from "./osascript";
import { buildCaptureScript, buildCloseScript, buildLaunchScript } from "./windows";

/** Headroom over an operation's own waiting, for osascript start-up and interop. */
const OVERHEAD_MS = 20_000;

/**
 * Where the Steam client keeps its libraries. Unlike Windows, macOS gives an
 * app no say in this: Steam is a sandboxed-era app bundle whose support files
 * always live in Application Support, so there is nothing to look up.
 */
function steamRoots(): string[] {
	return [path.join(homedir(), "Library", "Application Support", "Steam")];
}

/** The resolved Steam game for a config's appPath, or null for ordinary apps. */
function steamTarget(config: LaunchConfig | CloseConfig): SteamTarget | null {
	const launchArgs = "launchArgs" in config ? config.launchArgs : "";
	return resolveSteamTarget(steamRoots(), config.appPath, launchArgs);
}

/**
 * macOS backend: every operation is one osascript (JXA) process emitting a
 * single JSON line, mirroring the Windows backend's shape.
 *
 * Apps are launched with /usr/bin/open and their windows are controlled solely
 * through System Events — the target application is never scripted directly,
 * so the user grants Accessibility once instead of answering a per-app
 * "wants to control <app>" prompt for every key they configure.
 *
 * Virtual desktops are declared unsupported: macOS Spaces have no public API
 * for enumerating, creating, naming, or moving other apps' windows between
 * them, so LaunchConfig.virtualDesktop is ignored here rather than failing.
 */
export const macosBackend: PlatformBackend = {
	platform: "darwin",
	features: { virtualDesktop: false },

	launch(config: LaunchConfig): Promise<LaunchResult> {
		return runOsascript<LaunchResult>(
			buildLaunchScript(config, steamTarget(config)),
			config.waitSeconds * 1000 + OVERHEAD_MS,
		);
	},

	capture(config: LaunchConfig): Promise<CaptureResult> {
		return runOsascript<CaptureResult>(buildCaptureScript(config, steamTarget(config)), OVERHEAD_MS);
	},

	close(config: CloseConfig): Promise<CloseResult> {
		// closeThenKill spends up to waitSeconds waiting before force-quitting.
		const grace = config.closeMode === "closeThenKill" ? config.waitSeconds * 1000 : 0;
		return runOsascript<CloseResult>(buildCloseScript(config, steamTarget(config)), grace + OVERHEAD_MS);
	},

	listRunningApps(): Promise<RunningApp[]> {
		return runOsascript<RunningApp[]>(buildRunningListScript(), OVERHEAD_MS);
	},

	listInstalledApps(): Promise<InstalledApp[]> {
		// Walking every application directory is slower than the other operations.
		return runOsascript<InstalledApp[]>(buildInstalledListScript(), 30_000);
	},

	async listSteamGames(): Promise<InstalledApp[]> {
		// Reading Steam's own manifests is ordinary file I/O, so this needs no
		// osascript at all.
		return listSteamGames(steamRoots()).map(({ name, path: value }) => ({ name, path: value }));
	},

	async listMonitors(): Promise<MonitorEntry[]> {
		const screens = await runOsascript<RawScreen[]>(buildDisplayListScript(), OVERHEAD_MS);
		return toMonitorEntries(screens);
	},

	async findAppIcon(appPath: string): Promise<AppIconResult> {
		const steam = resolveSteamTarget(steamRoots(), appPath);
		const raw = await runOsascript<RawAppIcon>(buildAppIconScript(appPath, steam), OVERHEAD_MS);
		return toAppIconResult(raw);
	},
};
