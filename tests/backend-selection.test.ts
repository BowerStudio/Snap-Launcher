import assert from "node:assert/strict";
import { test } from "node:test";

import { selectBackend } from "../src/platform/index.ts";
import { macosBackend } from "../src/platform/macos/index.ts";
import { windowsBackend } from "../src/platform/windows/index.ts";

test("Windows selects the PowerShell backend", () => {
	const backend = selectBackend("win32");
	assert.equal(backend, windowsBackend);
	assert.equal(backend.platform, "win32");
});

test("macOS selects the osascript backend", () => {
	const backend = selectBackend("darwin");
	assert.equal(backend, macosBackend);
	assert.equal(backend.platform, "darwin");
});

test("virtual desktops are declared supported only on Windows", () => {
	assert.equal(selectBackend("win32").features.virtualDesktop, true);
	assert.equal(selectBackend("darwin").features.virtualDesktop, false);
});

test("an unsupported platform yields a stub that names the platform", async () => {
	const backend = selectBackend("linux");
	assert.equal(backend.platform, "linux");
	assert.equal(backend.features.virtualDesktop, false);

	// Every operation must fail the same legible way, not just the first one.
	const operations: (() => Promise<unknown>)[] = [
		() => backend.launch({} as never),
		() => backend.capture({} as never),
		() => backend.close({} as never),
		() => backend.listRunningApps(),
		() => backend.listInstalledApps(),
		() => backend.listSteamGames(),
		() => backend.listMonitors(),
	];

	for (const run of operations) {
		await assert.rejects(run, /Snap Launcher supports Windows and macOS; this is linux\./);
	}
});

test("every backend exposes the whole operation set", () => {
	for (const backend of [windowsBackend, macosBackend, selectBackend("linux")]) {
		for (const op of ["launch", "capture", "close", "listRunningApps", "listInstalledApps", "listSteamGames", "listMonitors"]) {
			assert.equal(typeof (backend as unknown as Record<string, unknown>)[op], "function", `${backend.platform}.${op}`);
		}
		assert.equal(typeof backend.features.virtualDesktop, "boolean", `${backend.platform}.features`);
	}
});
