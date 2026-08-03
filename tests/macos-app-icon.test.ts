import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { buildAppIconScript } from "../src/platform/macos/icons.ts";
import { ICON_MAX_PX, type SteamTarget } from "../src/platform/types.ts";

/**
 * The macOS icon script, executed against a double for the JXA ObjC bridge —
 * the same approach tests/macos-app-discovery.test.ts takes, and for the same
 * reason: what is worth checking is which file the script picks and what it
 * asks sips to do with it, neither of which a string match on the source can
 * tell you.
 *
 * The double reproduces the bridge's awkward edges (shallow unwrap, scalars
 * arriving as strings, zero-argument methods read as properties) so a script
 * that reads a value the way the real bridge does not allow fails here rather
 * than only on a Mac.
 */

/** What String() on any ObjC ref actually produces. */
const REF_TAG = "[id NSTaggedPointerString]";

function nsString(value: string | null): unknown {
	return value === null
		? { isNil: () => true, toString: () => REF_TAG }
		: { isNil: () => false, __string: value, toString: () => REF_TAG };
}

function nsArray(values: unknown[] | null): unknown {
	return values === null
		? { isNil: () => true, toString: () => REF_TAG }
		: { isNil: () => false, __array: values, toString: () => REF_TAG };
}

function has(v: unknown, key: string): boolean {
	return typeof v === "object" && v !== null && key in v;
}

/** The machine the script runs against. */
type Disk = {
	/** Directory listings, by absolute path. */
	dirs?: Record<string, string[]>;
	/** Files that exist, whether or not they are in a listed directory. */
	files?: string[];
	/** Info.plist key/values, by bundle path. */
	plists?: Record<string, Record<string, string>>;
	/** Bundle ids LaunchServices can resolve, to their bundle path. */
	installed?: Record<string, string>;
	/** Icon files sips can convert, to the base64 PNG it would produce. */
	convertible?: Record<string, string>;
};

type Run = {
	/** What the script returned, parsed. */
	result: Record<string, unknown>;
	/** Every subprocess the script ran. */
	tools: { launchPath: string; args: string[] }[];
	/** Paths still on disk in the temp directory when the script finished. */
	leftovers: string[];
};

function run(appPath: string, disk: Disk, steam?: SteamTarget | null): Run {
	const dirs = disk.dirs ?? {};
	const files = new Set(disk.files ?? []);
	const plists = disk.plists ?? {};
	const installed = disk.installed ?? {};
	const convertible = disk.convertible ?? {};

	const tools: { launchPath: string; args: string[] }[] = [];
	// What sips has written, so the script can read its output back.
	const written = new Map<string, string>();

	const fileManager = {
		contentsOfDirectoryAtPathError: (dir: string) => nsArray(dirs[dir] ? dirs[dir].map((n) => nsString(n)) : null),
		fileExistsAtPath: (p: string) => files.has(p) || written.has(p),
		removeItemAtPathError: (p: string) => {
			written.delete(p);
			return true;
		},
	};

	/** NSTask as runTool drives it: launch and waitUntilExit are property reads. */
	function newTask(): Record<string, unknown> {
		const task: Record<string, unknown> = {
			launchPath: "",
			arguments: [],
			standardOutput: null,
			standardError: null,
			terminationStatus: "0",
		};
		Object.defineProperty(task, "launch", { get: () => undefined });
		Object.defineProperty(task, "waitUntilExit", {
			get: () => {
				const launchPath = String(task.launchPath);
				// Array.from, not .map: the script's array belongs to the vm's
				// realm, and a deepEqual against a plain one would fail on that
				// alone.
				const args = Array.from(task.arguments as string[], (a) => String(a));
				tools.push({ launchPath, args });
				// sips reads its input and writes the path after --out.
				const input = args[args.length - 3];
				const out = args[args.length - 1];
				const png = convertible[input];
				if (png === undefined) {
					task.terminationStatus = "1";
				} else {
					written.set(out, png);
					task.terminationStatus = "0";
				}
				return undefined;
			},
		});
		return task;
	}

	const dollar: Record<string, unknown> = {
		NSWorkspace: {
			sharedWorkspace: {
				URLForApplicationWithBundleIdentifier: (id: string) => {
					const path = installed[id];
					return path ? { isNil: () => false, path: nsString(path) } : { isNil: () => true };
				},
			},
		},
		NSBundle: {
			bundleWithPath: (p: string) => {
				const entry = Object.entries(installed).find(([, path]) => path === p);
				return entry ? { isNil: () => false, bundleIdentifier: nsString(entry[0]) } : { isNil: () => true };
			},
		},
		NSFileManager: { defaultManager: fileManager },
		NSDictionary: {
			dictionaryWithContentsOfFile: (p: string) => {
				// Info.plist is addressed by its bundle, one level up from it.
				const bundle = p.replace(/\/Contents\/Info\.plist$/, "");
				const values = plists[bundle];
				if (!values) return { isNil: () => true };
				return {
					isNil: () => false,
					objectForKey: (key: string) => nsString(key in values ? values[key] : null),
				};
			},
		},
		NSData: {
			dataWithContentsOfFile: (p: string) => {
				const content = written.get(p);
				return content === undefined
					? { isNil: () => true }
					: {
							isNil: () => false,
							// Bridged scalars arrive as strings, never numbers.
							length: String(content.length),
							base64EncodedStringWithOptions: () => nsString(content),
						};
			},
		},
		NSTemporaryDirectory: () => nsString("/var/tmp/"),
		NSTask: {
			alloc: {
				get init() {
					return newTask();
				},
			},
		},
		NSFileHandle: { fileHandleWithNullDevice: {} },
		NSThread: { sleepForTimeInterval: () => undefined },
	};

	const sandbox: Record<string, unknown> = {
		ObjC: {
			import: () => undefined,
			unwrap: (v: unknown) => {
				if (typeof v !== "object" || v === null) return v;
				// Shallow by design: a collection's elements stay bridged.
				if (has(v, "__array")) return [...(v as { __array: unknown[] }).__array];
				if (has(v, "__string")) return (v as { __string: string }).__string;
				return v;
			},
		},
		// The script calls $() for the nil error pointer.
		$: Object.assign(() => undefined, dollar),
		JSON,
		Math,
		Number,
		String,
		Date,
		Error,
	};

	const output = vm.runInNewContext(buildAppIconScript(appPath, steam), sandbox) as string;
	return { result: JSON.parse(output) as Record<string, unknown>, tools, leftovers: [...written.keys()] };
}

/** A bundle whose Info.plist names its icon, and whose icon sips can convert. */
function slack(overrides: Partial<Disk> = {}): Disk {
	return {
		dirs: { "/Applications/Slack.app/Contents/Resources": ["Slack.icns", "Assets.car"] },
		files: ["/Applications/Slack.app/Contents/Resources/Slack.icns"],
		plists: { "/Applications/Slack.app": { CFBundleIconFile: "Slack.icns" } },
		installed: { "com.tinyspeck.slackmacgap": "/Applications/Slack.app" },
		convertible: { "/Applications/Slack.app/Contents/Resources/Slack.icns": "UE5HZGF0YQ==" },
		...overrides,
	};
}

test("the icon named by Info.plist is converted, capped at the key size", () => {
	const { result, tools } = run("bundle:com.tinyspeck.slackmacgap", slack());

	assert.equal(result.ok, true);
	assert.equal(result.found, true);
	assert.equal(result.path, "/Applications/Slack.app/Contents/Resources/Slack.icns");
	assert.equal(result.png, "UE5HZGF0YQ==");

	assert.equal(tools.length, 1);
	assert.equal(tools[0].launchPath, "/usr/bin/sips");
	assert.deepEqual(tools[0].args.slice(0, 7), [
		"-s",
		"format",
		"png",
		"--resampleHeightWidthMax",
		String(ICON_MAX_PX),
		"/Applications/Slack.app/Contents/Resources/Slack.icns",
		"--out",
	]);
	assert.match(tools[0].args[7], /^\/var\/tmp\/snap-launcher-icon-\d+\.png$/);
});

test("CFBundleIconFile without an extension still resolves", () => {
	// Plenty of bundles record the icon as a bare name.
	const disk = slack({ plists: { "/Applications/Slack.app": { CFBundleIconFile: "Slack" } } });

	const { result } = run("bundle:com.tinyspeck.slackmacgap", disk);

	assert.equal(result.found, true);
	assert.equal(result.path, "/Applications/Slack.app/Contents/Resources/Slack.icns");
});

test("a bundle with no CFBundleIconFile falls back to the .icns in Resources", () => {
	const disk = slack({ plists: {} });

	const { result } = run("bundle:com.tinyspeck.slackmacgap", disk);

	assert.equal(result.found, true);
	assert.equal(result.path, "/Applications/Slack.app/Contents/Resources/Slack.icns");
});

test("an app that keeps its icon in an asset catalog is a miss, not a guess", () => {
	// Modern apps ship Assets.car and no .icns; sips cannot read it.
	const disk = slack({
		dirs: { "/Applications/Slack.app/Contents/Resources": ["Assets.car", "en.lproj"] },
		files: [],
		plists: {},
	});

	const { result, tools } = run("bundle:com.tinyspeck.slackmacgap", disk);

	assert.equal(result.ok, true);
	assert.equal(result.found, false);
	assert.match(String(result.reason), /No \.icns icon was found/);
	assert.equal(tools.length, 0, "nothing should be run when there is nothing to convert");
});

test("an app that cannot be located at all reports so", () => {
	const { result } = run("bundle:com.example.gone", { installed: {} });

	assert.equal(result.found, false);
	assert.match(String(result.reason), /where this application lives/);
});

test("a conversion that fails is a miss rather than a broken image", () => {
	const disk = slack({ convertible: {} });

	const { result } = run("bundle:com.tinyspeck.slackmacgap", disk);

	assert.equal(result.ok, true);
	assert.equal(result.found, false);
	assert.match(String(result.reason), /could not be converted/);
});

test("the temp file sips writes is always cleaned up", () => {
	assert.deepEqual(run("bundle:com.tinyspeck.slackmacgap", slack()).leftovers, []);
	// Including when the conversion failed and there was nothing to read back.
	assert.deepEqual(run("bundle:com.tinyspeck.slackmacgap", slack({ convertible: {} })).leftovers, []);
});

const game: SteamTarget = {
	appId: "1361210",
	name: "Elden Ring",
	installDir: "/Users/dean/Library/Application Support/Steam/steamapps/common/ELDEN RING",
	launchUrl: "steam://rungameid/1361210",
};

test("a Steam game's icon comes from the .app inside its install directory", () => {
	const bundle = `${game.installDir}/Game.app`;
	const { result } = run(
		"steam:1361210",
		{
			dirs: {
				[game.installDir]: ["Game.app", "readme.txt"],
				[`${bundle}/Contents/Resources`]: ["Game.icns"],
			},
			files: [`${bundle}/Contents/Resources/Game.icns`],
			plists: { [bundle]: { CFBundleIconFile: "Game" } },
			convertible: { [`${bundle}/Contents/Resources/Game.icns`]: "Z2FtZQ==" },
		},
		game,
	);

	assert.equal(result.found, true);
	assert.equal(result.path, `${bundle}/Contents/Resources/Game.icns`);
});

test("a Steam game that isn't installed is named in the miss", () => {
	const { result } = run("steam:1361210", {}, { ...game, installDir: "" });

	assert.equal(result.found, false);
	assert.match(String(result.reason), /Elden Ring/);
});
