import type { PlatformBackend } from "../backend";
import type {
	CaptureResult,
	CloseConfig,
	CloseResult,
	InstalledApp,
	LaunchConfig,
	LaunchResult,
	MonitorEntry,
	RunningApp,
} from "../types";
import { buildInstalledListScript, buildRunningListScript } from "./apps";
import { buildDisplayListScript, toMonitorEntries, type RawScreen } from "./displays";
import { runOsascript } from "./osascript";
import { buildCaptureScript, buildCloseScript, buildLaunchScript } from "./windows";

/** Headroom over an operation's own waiting, for osascript start-up and interop. */
const OVERHEAD_MS = 20_000;

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
		return runOsascript<LaunchResult>(buildLaunchScript(config), config.waitSeconds * 1000 + OVERHEAD_MS);
	},

	capture(config: LaunchConfig): Promise<CaptureResult> {
		return runOsascript<CaptureResult>(buildCaptureScript(config), OVERHEAD_MS);
	},

	close(config: CloseConfig): Promise<CloseResult> {
		// closeThenKill spends up to waitSeconds waiting before force-quitting.
		const grace = config.closeMode === "closeThenKill" ? config.waitSeconds * 1000 : 0;
		return runOsascript<CloseResult>(buildCloseScript(config), grace + OVERHEAD_MS);
	},

	listRunningApps(): Promise<RunningApp[]> {
		return runOsascript<RunningApp[]>(buildRunningListScript(), OVERHEAD_MS);
	},

	listInstalledApps(): Promise<InstalledApp[]> {
		// Walking every application directory is slower than the other operations.
		return runOsascript<InstalledApp[]>(buildInstalledListScript(), 30_000);
	},

	async listMonitors(): Promise<MonitorEntry[]> {
		const screens = await runOsascript<RawScreen[]>(buildDisplayListScript(), OVERHEAD_MS);
		return toMonitorEntries(screens);
	},
};
