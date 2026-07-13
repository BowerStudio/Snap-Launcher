import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import {
	buildCaptureScript,
	buildLaunchScript,
	buildListScript,
	buildMonitorListScript,
	runPowerShell,
	type CaptureResult,
	type LaunchResult,
	type MonitorEntry,
	type RunningApp,
} from "../powershell";
import { toConfig, type LaunchSettings } from "../settings";

const logger = streamDeck.logger.createScope("LaunchApp");

/** Minimal surface needed by setStatus — satisfied by both key and dial actions. */
type SettingsHolder = {
	getSettings(): Promise<LaunchSettings>;
	setSettings(settings: LaunchSettings): Promise<void>;
};

@action({ UUID: "com.myorg.window-launcher.launch" })
export class LaunchApp extends SingletonAction<LaunchSettings> {
	/** Friendly names of the apps offered in the last Running-apps scan, by value. */
	private appNames = new Map<string, string>();

	/**
	 * Seed defaults once so the Property Inspector checkboxes reflect the
	 * behavior the plugin will actually use.
	 */
	override async onWillAppear(ev: WillAppearEvent<LaunchSettings>): Promise<void> {
		const settings = ev.payload.settings;

		const seeded: LaunchSettings = { ...settings };
		let changed = false;
		if (seeded.focusIfRunning === undefined) {
			seeded.focusIfRunning = true;
			changed = true;
		}
		if (seeded.waitSeconds === undefined) {
			seeded.waitSeconds = 10;
			changed = true;
		}
		if (seeded.positionMode === undefined) {
			// Migrate legacy keys from applyPosition; new keys default to custom.
			seeded.positionMode = (seeded.applyPosition ?? true) ? "custom" : "none";
			changed = true;
		}
		if (changed) {
			await ev.action.setSettings(seeded);
		}

		// Plugin-set titles don't survive Stream Deck restarts; re-apply ours.
		// Stream Deck ignores this whenever the user has typed a custom Title.
		if (ev.action.isKey() && settings.autoTitle) {
			await ev.action.setTitle(settings.autoTitle);
		}
	}

	/**
	 * Auto-title the key with the app's name when a different app is picked.
	 * setTitle only shows while the user's own Title field is empty, so a
	 * manually entered title always wins.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LaunchSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const appPath = (settings.appPath ?? "").trim();
		if (!appPath || appPath === settings.titledFor) {
			return;
		}

		const name = this.appNames.get(appPath) ?? friendlyName(appPath);
		if (!name) {
			return;
		}

		if (ev.action.isKey()) {
			await ev.action.setTitle(name);
		}
		await ev.action.setSettings({ ...settings, titledFor: appPath, autoTitle: name });
	}

	/** Launch or focus the app, then move its window to the saved rectangle. */
	override async onKeyDown(ev: KeyDownEvent<LaunchSettings>): Promise<void> {
		const settings = ev.payload.settings;
		if (!settings.appPath) {
			await ev.action.showAlert();
			await this.setStatus(ev.action, "No application selected — open the key settings and pick one.");
			return;
		}

		try {
			const config = toConfig(settings);
			const result = await runPowerShell<LaunchResult>(buildLaunchScript(config), config.waitSeconds * 1000 + 20_000);

			if (result.ok) {
				logger.debug(`ok launched=${result.launched} positioned=${result.positioned} pid=${result.pid}`);
				await ev.action.showOk();
			} else {
				logger.error(`Launch failed: ${result.error}`);
				await ev.action.showAlert();
				await this.setStatus(ev.action, `Launch failed: ${result.error}`);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			logger.error(`Launch error: ${message}`);
			await ev.action.showAlert();
			await this.setStatus(ev.action, `Launch error: ${message}`);
		}
	}

	/** Routes messages from the Property Inspector. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, LaunchSettings>): Promise<void> {
		const payload = ev.payload;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			return;
		}
		const event = (payload as Record<string, JsonValue>)["event"];

		if (event === "getRunningApps") {
			await this.sendRunningApps();
		} else if (event === "getMonitors") {
			await this.sendMonitors();
		} else if (event === "captureWindow") {
			await this.captureWindow(ev);
		}
	}

	/** Populates the "Running apps" dropdown (sdpi-select datasource). */
	private async sendRunningApps(): Promise<void> {
		let items: { label: string; value: string }[] = [];

		try {
			const apps = await runPowerShell<RunningApp[]>(buildListScript(), 20_000);
			if (Array.isArray(apps)) {
				const seen = new Set<string>();
				items = apps
					.filter((a): a is RunningApp & { path: string } => typeof a.path === "string" && a.path.length > 0)
					.filter((a) => {
						const key = a.path.toLowerCase();
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					})
					.sort((a, b) => a.title.localeCompare(b.title))
					.map((a) => {
						const display = (a.display ?? "").trim() || a.name;
						this.appNames.set(a.path, display);
						// Skip the app-name suffix when the window title already contains it.
						const label = a.title.toLowerCase().includes(display.toLowerCase())
							? truncate(a.title, 40)
							: `${truncate(a.title, 40)} - ${display}`;
						return { label, value: a.path };
					});
			}
		} catch (e) {
			logger.error(`Failed to list running apps: ${e instanceof Error ? e.message : String(e)}`);
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "getRunningApps", items });
	}

	/** Populates the "Monitor" dropdown (sdpi-select datasource). */
	private async sendMonitors(): Promise<void> {
		const items: { label: string; value: string }[] = [{ label: "Primary monitor", value: "primary" }];

		try {
			const monitors = await runPowerShell<MonitorEntry[]>(buildMonitorListScript(), 20_000);
			if (Array.isArray(monitors)) {
				const sorted = [...monitors].sort((a, b) => a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true }));
				for (const m of sorted) {
					const n = /(\d+)$/.exec(m.deviceName)?.[1];
					items.push({
						label: `Monitor ${n ?? m.deviceName} — ${m.width}×${m.height}${m.isPrimary ? " (primary)" : ""}`,
						value: m.deviceName,
					});
				}
			}
		} catch (e) {
			logger.error(`Failed to list monitors: ${e instanceof Error ? e.message : String(e)}`);
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "getMonitors", items });
	}

	/** Captures the current window rect of the configured app into settings. */
	private async captureWindow(ev: SendToPluginEvent<JsonValue, LaunchSettings>): Promise<void> {
		const key = ev.action.isKey() ? ev.action : undefined;
		const settings = await ev.action.getSettings();

		if (!settings.appPath) {
			await key?.showAlert();
			await this.setStatus(ev.action, "Pick an application first, then capture.");
			return;
		}

		try {
			const result = await runPowerShell<CaptureResult>(buildCaptureScript(toConfig(settings)), 20_000);

			if (result.ok) {
				const status =
					`Saved ${result.width}×${result.height} at (${result.x}, ${result.y})` +
					(result.maximized ? " — window was maximized" : "");
				await ev.action.setSettings({
					...settings,
					x: result.x,
					y: result.y,
					width: result.width,
					height: result.height,
					captureStatus: status,
				});
				await key?.showOk();
			} else {
				await this.setStatus(ev.action, result.error);
				await key?.showAlert();
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			logger.error(`Capture failed: ${message}`);
			await this.setStatus(ev.action, `Capture failed: ${message}`);
			await key?.showAlert();
		}
	}

	/** Writes a status line into settings; the PI shows it via a bound field. */
	private async setStatus(holder: SettingsHolder, message: string): Promise<void> {
		try {
			const settings = await holder.getSettings();
			await holder.setSettings({ ...settings, captureStatus: message });
		} catch (e) {
			logger.warn(`Could not persist status: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Fallback key title when the picked app wasn't in the last Running-apps scan
 * (e.g. chosen via the file browser): the file name without its extension.
 * Store-app identities carry no readable name, so those yield nothing.
 */
function friendlyName(appPath: string): string {
	if (appPath.toLowerCase().startsWith("shell:appsfolder\\") || appPath.includes("!")) {
		return "";
	}
	const base = appPath.split(/[\\/]/).pop() ?? "";
	return base.replace(/\.(exe|lnk|bat|cmd)$/i, "");
}
