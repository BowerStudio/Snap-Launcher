import streamDeck from "@elgato/streamdeck";
import type { DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { getBackend, type InstalledApp, type RunningApp } from "../platform";

const logger = streamDeck.logger.createScope("Pickers");

/**
 * Friendly names of the apps offered in the last Running/Installed-apps scan,
 * by value. Shared by every action so a key auto-titles correctly no matter
 * which action's Property Inspector performed the scan.
 */
export const appNames = new Map<string, string>();

/** Populates a "Running apps" dropdown (sdpi-select datasource). */
export async function sendRunningApps(): Promise<void> {
	let items: { label: string; value: string }[] = [];

	try {
		const apps = await getBackend().listRunningApps();
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
					appNames.set(a.path, display);
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

/** Populates an "Installed apps" dropdown (sdpi-select datasource). */
export async function sendInstalledApps(): Promise<void> {
	await sendAppList("getInstalledApps", () => getBackend().listInstalledApps(), "installed apps");
}

/** Populates a "Steam games" dropdown (sdpi-select datasource). */
export async function sendSteamGames(): Promise<void> {
	await sendAppList("getSteamGames", () => getBackend().listSteamGames(), "Steam games");
}

/**
 * Sends one name/value list to the Property Inspector. A scan that fails sends
 * an empty list rather than nothing at all, so the dropdown settles on its
 * placeholder instead of spinning on "Loading…" forever.
 */
async function sendAppList(event: string, scan: () => Promise<InstalledApp[]>, what: string): Promise<void> {
	let items: { label: string; value: string }[] = [];

	try {
		const apps = await scan();
		if (Array.isArray(apps)) {
			items = apps
				.filter((a) => typeof a.path === "string" && a.path.length > 0 && typeof a.name === "string" && a.name.length > 0)
				.map((a) => {
					appNames.set(a.path, a.name);
					return { label: truncate(a.name, 50), value: a.path };
				});
		}
	} catch (e) {
		logger.error(`Failed to list ${what}: ${e instanceof Error ? e.message : String(e)}`);
	}

	await streamDeck.ui.sendToPropertyInspector({ event, items });
}

type TitledSettings = JsonObject & { appPath?: string; titledFor?: string; autoTitle?: string };

/**
 * Auto-title the key with the app's name when a different app is picked.
 * setTitle only shows while the user's own Title field is empty, so a
 * manually entered title always wins.
 */
export async function applyAutoTitle<T extends TitledSettings>(ev: DidReceiveSettingsEvent<T>): Promise<void> {
	const settings = ev.payload.settings;
	const appPath = (settings.appPath ?? "").trim();
	if (!appPath || appPath === settings.titledFor) {
		return;
	}

	const name = appNames.get(appPath) ?? friendlyName(appPath);
	if (!name) {
		return;
	}

	if (ev.action.isKey()) {
		await ev.action.setTitle(name);
	}
	await ev.action.setSettings({ ...settings, titledFor: appPath, autoTitle: name });
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Fallback key title when the picked app wasn't in the last apps scan
 * (e.g. chosen via the file browser): the file name without its extension.
 *
 * Identity-style values carry no readable name and yield nothing: a Windows
 * Store AUMID, a macOS "bundle:com.tinyspeck.slackmacgap", and a "steam:1361210"
 * — the trailing component of a bundle id, or a Steam app id, is not a name
 * anyone would recognise on a key.
 */
export function friendlyName(appPath: string): string {
	const lower = appPath.toLowerCase();
	if (lower.startsWith("shell:appsfolder\\") || appPath.includes("!") || lower.startsWith("bundle:") || lower.startsWith("steam:")) {
		return "";
	}
	const base = appPath.split(/[\\/]/).pop() ?? "";
	return base.replace(/\.(exe|lnk|bat|cmd|app)$/i, "");
}
