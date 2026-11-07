import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTOMATIC, fileName, pickerView } from "../com.bowerstudio.snap-launcher.sdPlugin/ui/icon-picker.js";

const APP = "steam:365590";
const EXE = "D:\\SteamLibrary\\steamapps\\common\\Tom Clancy's The Division\\TheDivision.exe";
const ICO = "C:\\Program Files (x86)\\Steam\\steam\\games\\abc.ico";
const icons = [
	{ path: ICO, width: 256, height: 256, image: "data:image/png;base64,AAA" },
	{ path: EXE, width: 256, height: 256, image: "data:image/png;base64,BBB" },
];

test("the automatic tile comes first, then every icon, and Automatic is selected by default", () => {
	const view = pickerView({ appPath: APP, icons }, { appPath: APP });
	assert.deepEqual(
		view.tiles.map((t) => [t.path, t.selected]),
		[
			[AUTOMATIC, true],
			[ICO, false],
			[EXE, false],
		],
	);
	assert.match(view.tiles[2].title, /^TheDivision\.exe — 256×256\n/);
});

test("the user's choice is what is selected", () => {
	const view = pickerView({ appPath: APP, icons }, { appPath: APP, iconChoice: EXE });
	assert.deepEqual(
		view.tiles.filter((t) => t.selected).map((t) => t.path),
		[EXE],
	);
});

test("a choice no longer on offer selects nothing rather than claiming Automatic", () => {
	const view = pickerView({ appPath: APP, icons }, { appPath: APP, iconChoice: "C:\\gone.ico" });
	assert.equal(
		view.tiles.some((t) => t.selected),
		false,
	);
});

test("a reply for another app, while loading, or with no icons shows no tiles", () => {
	assert.deepEqual(pickerView({ appPath: "steam:1", icons }, { appPath: APP }).tiles, []);
	assert.deepEqual(pickerView(null, { appPath: APP }), { message: "", tiles: [] });

	const loading = pickerView({ appPath: APP, loading: true }, { appPath: APP });
	assert.deepEqual(loading.tiles, []);
	assert.match(loading.message, /Looking/);

	const none = pickerView({ appPath: APP, icons: [], reason: "Nothing here." }, { appPath: APP });
	assert.deepEqual(none, { message: "Nothing here.", tiles: [] });
});

test("entries without an image or a path are never offered", () => {
	const view = pickerView(
		{ appPath: APP, icons: [{ path: ICO, image: "" }, { path: "", image: "data:x" }, icons[1]] },
		{ appPath: APP },
	);
	assert.deepEqual(
		view.tiles.map((t) => t.path),
		[AUTOMATIC, EXE],
	);
});

test("fileName handles either slash style", () => {
	assert.equal(fileName(EXE), "TheDivision.exe");
	assert.equal(fileName("/Applications/Steam.app"), "Steam.app");
	assert.equal(fileName(undefined), "");
});
