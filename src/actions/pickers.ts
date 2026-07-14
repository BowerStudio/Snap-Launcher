import streamDeck, { DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { buildInstalledListScript, buildListScript, runPowerShell, type InstalledApp, type RunningApp } from "../powershell";

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
	let items: { label: string; value: string }[] = [];

	try {
		const apps = await runPowerShell<InstalledApp[]>(buildInstalledListScript(), 30_000);
		if (Array.isArray(apps)) {
			items = apps
				.filter((a) => typeof a.path === "string" && a.path.length > 0 && typeof a.name === "string" && a.name.length > 0)
				.map((a) => {
					appNames.set(a.path, a.name);
					return { label: truncate(a.name, 50), value: a.path };
				});
		}
	} catch (e) {
		logger.error(`Failed to list installed apps: ${e instanceof Error ? e.message : String(e)}`);
	}

	await streamDeck.ui.sendToPropertyInspector({ event: "getInstalledApps", items });
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
 * Store-app identities carry no readable name, so those yield nothing.
 */
export function friendlyName(appPath: string): string {
	if (appPath.toLowerCase().startsWith("shell:appsfolder\\") || appPath.includes("!")) {
		return "";
	}
	const base = appPath.split(/[\\/]/).pop() ?? "";
	return base.replace(/\.(exe|lnk|bat|cmd)$/i, "");
}
