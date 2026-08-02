import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import {
	appIdentity,
	buildInstalledListScript,
	buildRunningListScript,
	bundleDisplayName,
	parseIdentity,
} from "../src/platform/macos/apps.ts";
import { friendlyName } from "../src/actions/pickers.ts";

/* --------------------------------- identity -------------------------------- */

test("an app with a bundle id is stored by that id", () => {
	assert.equal(
		appIdentity("/Applications/Slack.app", "com.tinyspeck.slackmacgap"),
		"bundle:com.tinyspeck.slackmacgap",
	);
});

test("an app without a bundle id falls back to its path", () => {
	assert.equal(appIdentity("/Applications/Odd.app", null), "/Applications/Odd.app");
	assert.equal(appIdentity("/Applications/Odd.app", "  "), "/Applications/Odd.app");
});

test("identities round-trip", () => {
	assert.deepEqual(parseIdentity("bundle:com.apple.Safari"), { bundleId: "com.apple.Safari", bundlePath: null });
	assert.deepEqual(parseIdentity("/Applications/Odd.app"), { bundleId: null, bundlePath: "/Applications/Odd.app" });
	assert.deepEqual(parseIdentity(""), { bundleId: null, bundlePath: null });
});

test("bundleDisplayName strips the extension", () => {
	assert.equal(bundleDisplayName("/Applications/Visual Studio Code.app"), "Visual Studio Code");
	assert.equal(bundleDisplayName("/System/Applications/Utilities/Terminal.app"), "Terminal");
});

test("friendlyName titles a browsed-for bundle but not a bundle id", () => {
	assert.equal(friendlyName("/Applications/Slack.app"), "Slack");
	assert.equal(friendlyName("bundle:com.tinyspeck.slackmacgap"), "");
	// Windows behavior is unchanged.
	assert.equal(friendlyName("C:\\Program Files\\Foo\\foo.exe"), "foo");
	assert.equal(friendlyName("shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"), "");
});

/* ------------------------------ AppKit test double ------------------------- */

/**
 * A double for the JXA ObjC bridge.
 *
 * It reproduces the bridge's awkward edges rather than an idealised version of
 * them, because every edge modelled here has already shipped a bug that an
 * accommodating double hid:
 *
 *   - ObjC.unwrap on a collection is shallow. The elements stay ObjC refs, and
 *     String() on a ref yields a type tag, never the value.
 *   - Scalar properties like activationPolicy and count arrive as strings, so
 *     a strict === against a number is always false.
 *   - A function returning CFTypeRef hands back an opaque Ref that has no
 *     isNil and that ObjC.unwrap cannot read; only castRefToObject opens it.
 *
 * If a script under test reads a value the way the real bridge does not allow,
 * these fakes make it fail here rather than only on a Mac.
 */

type Bundle = { path: string; id: string | null };

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

/** A CFTypeRef as JXA surfaces one: opaque until cast. */
function cfRef(object: unknown): unknown {
	return { __ref: object };
}

function has(v: unknown, key: string): boolean {
	return typeof v === "object" && v !== null && key in v;
}

/** ObjC.deepUnwrap: recursively converts a bridged graph to plain JS. */
function deepUnwrap(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(deepUnwrap);
	if (typeof v !== "object" || v === null) return v;
	if (has(v, "__string")) return (v as { __string: string }).__string;
	if (has(v, "__array")) return (v as { __array: unknown[] }).__array.map(deepUnwrap);
	if (has(v, "__ref")) return deepUnwrap((v as { __ref: unknown }).__ref);
	const out: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(v)) out[k] = deepUnwrap(val);
	return out;
}

/** Minimal sandbox shared by both list scripts. */
function baseSandbox(bundles: Bundle[]): Record<string, unknown> {
	const byPath = new Map(bundles.map((b) => [b.path, b]));
	return {
		ObjC: {
			import: () => undefined,
			unwrap: (v: unknown) => {
				if (typeof v !== "object" || v === null) return v;
				// An opaque Ref is not something unwrap can read.
				if (has(v, "__ref")) return v;
				// Shallow by design: the elements come back still bridged.
				if (has(v, "__array")) return [...(v as { __array: unknown[] }).__array];
				if (has(v, "__string")) return (v as { __string: string }).__string;
				return v;
			},
			deepUnwrap,
			castRefToObject: (v: unknown) => (has(v, "__ref") ? (v as { __ref: unknown }).__ref : v),
		},
		$: {
			NSBundle: {
				bundleWithPath: (p: string) => {
					const found = byPath.get(p);
					return found ? { isNil: () => false, bundleIdentifier: nsString(found.id) } : { isNil: () => true };
				},
			},
			NSWorkspace: { sharedWorkspace: {} },
			NSHomeDirectory: () => nsString("/Users/dean"),
		},
		JSON,
		Math,
		Number,
		String,
		Error,
	};
}

/* ----------------------------- installed apps ------------------------------ */

type InstalledItem = { name: string; path: string };

function runInstalled(tree: Record<string, string[]>, bundles: Bundle[]): InstalledItem[] {
	const sandbox = baseSandbox(bundles);
	const $ = sandbox.$ as Record<string, unknown>;
	$.NSFileManager = {
		defaultManager: {
			// Directory entries arrive as NSStrings, not JS strings.
			contentsOfDirectoryAtPathError: (dir: string) =>
				nsArray(tree[dir] ? tree[dir].map((n) => nsString(n)) : null),
			fileExistsAtPath: (p: string) => bundles.some((b) => b.path === p),
		},
	};
	// The script calls $() for the nil error pointer.
	const dollar = Object.assign(() => undefined, $);
	sandbox.$ = dollar;

	const output = vm.runInNewContext(buildInstalledListScript(), sandbox) as string;
	return JSON.parse(output) as InstalledItem[];
}

test("installed apps are found in every searched root, including one level down", () => {
	const items = runInstalled(
		{
			"/Applications": ["Slack.app", "Utilities"],
			"/Applications/Utilities": ["Terminal.app"],
			"/System/Applications": ["Safari.app"],
			"/Users/dean/Applications": ["Local.app"],
		},
		[
			{ path: "/Applications/Slack.app", id: "com.tinyspeck.slackmacgap" },
			{ path: "/Applications/Utilities/Terminal.app", id: "com.apple.Terminal" },
			{ path: "/System/Applications/Safari.app", id: "com.apple.Safari" },
			{ path: "/Users/dean/Applications/Local.app", id: "com.example.local" },
		],
	);

	assert.deepEqual(
		items.map((i) => i.name),
		["Local", "Safari", "Slack", "Terminal"],
		"every root is searched and the result is sorted by name",
	);
});

test("the same app in two roots appears once", () => {
	const items = runInstalled(
		{
			"/Applications": ["Slack.app"],
			"/System/Applications": [],
			"/Users/dean/Applications": ["Slack.app"],
		},
		[
			{ path: "/Applications/Slack.app", id: "com.tinyspeck.slackmacgap" },
			{ path: "/Users/dean/Applications/Slack.app", id: "com.tinyspeck.slackmacgap" },
		],
	);

	assert.equal(items.length, 1);
	assert.equal(items[0].path, "bundle:com.tinyspeck.slackmacgap");
});

test("an app with no bundle id is still listed, by path", () => {
	const items = runInstalled(
		{ "/Applications": ["Odd.app"], "/System/Applications": [], "/Users/dean/Applications": [] },
		[{ path: "/Applications/Odd.app", id: null }],
	);

	assert.deepEqual(items, [{ name: "Odd", path: "/Applications/Odd.app" }]);
});

test("unreadable directories yield an empty list rather than an error", () => {
	assert.deepEqual(runInstalled({}, []), []);
});

/* ------------------------------ running apps ------------------------------- */

type RunningItem = { name: string; title: string; path: string; display: string };
type FakeApp = { policy: number; path: string | null; id: string | null; name: string; pid: number };

function runRunning(apps: FakeApp[], windows: Record<string, unknown>[], windowList?: () => unknown): RunningItem[] {
	const sandbox = baseSandbox([]);
	const $ = sandbox.$ as Record<string, unknown>;
	($.NSWorkspace as { sharedWorkspace: Record<string, unknown> }).sharedWorkspace = {
		// count and activationPolicy are both string-valued over the bridge.
		count: String(apps.length),
		runningApplications: {
			count: String(apps.length),
			objectAtIndex: (i: number) => ({
				activationPolicy: String(apps[i].policy),
				bundleURL:
					apps[i].path === null
						? { isNil: () => true }
						: { isNil: () => false, path: nsString(apps[i].path) },
				bundleIdentifier: nsString(apps[i].id),
				localizedName: nsString(apps[i].name),
				// A pid, unlike the enums above, really does arrive as a number.
				processIdentifier: apps[i].pid,
			}),
		},
	};
	// CFArrayRef: opaque until castRefToObject.
	$.CGWindowListCopyWindowInfo = windowList ?? (() => cfRef(nsArray(windows)));

	const output = vm.runInNewContext(buildRunningListScript(), sandbox) as string;
	return JSON.parse(output) as RunningItem[];
}

const regular = (over: Partial<FakeApp>): FakeApp => ({
	policy: 0,
	path: "/Applications/Slack.app",
	id: "com.tinyspeck.slackmacgap",
	name: "Slack",
	pid: 501,
	...over,
});

test("running apps carry their window title and a launchable identity", () => {
	const items = runRunning(
		[regular({})],
		[{ kCGWindowOwnerPID: 501, kCGWindowLayer: 0, kCGWindowName: "general — Slack" }],
	);

	assert.equal(items.length, 1);
	assert.equal(items[0].title, "general — Slack");
	assert.equal(items[0].name, "Slack");
	assert.equal(items[0].path, "bundle:com.tinyspeck.slackmacgap", "the same identity the installed picker produces");
});

test("background-only applications are excluded", () => {
	const items = runRunning(
		[
			regular({}),
			// Accessory: menu-bar-only, no Dock icon, no windows to position.
			regular({ policy: 1, path: "/Applications/Agent.app", id: "com.example.agent", name: "Agent", pid: 502 }),
			regular({
				policy: 2,
				path: "/Applications/Hidden.app",
				id: "com.example.hidden",
				name: "Hidden",
				pid: 503,
			}),
		],
		[{ kCGWindowOwnerPID: 501, kCGWindowLayer: 0, kCGWindowName: "Slack" }],
	);

	assert.deepEqual(
		items.map((i) => i.name),
		["Slack"],
	);
});

test("an app with several windows appears once", () => {
	const items = runRunning(
		[regular({})],
		[
			{ kCGWindowOwnerPID: 501, kCGWindowLayer: 0, kCGWindowName: "first window" },
			{ kCGWindowOwnerPID: 501, kCGWindowLayer: 0, kCGWindowName: "second window" },
		],
	);

	assert.equal(items.length, 1);
	assert.equal(items[0].title, "first window", "the frontmost window's title is used");
});

test("non-window layers are ignored when picking a title", () => {
	const items = runRunning(
		[regular({})],
		[
			// A menu or panel sits above layer 0 and is not the app's window.
			{ kCGWindowOwnerPID: 501, kCGWindowLayer: 25, kCGWindowName: "a menu" },
			{ kCGWindowOwnerPID: 501, kCGWindowLayer: 0, kCGWindowName: "real window" },
		],
	);

	assert.equal(items[0].title, "real window");
});

/**
 * Window titles come from the window server, which only reports them when
 * Screen Recording has been granted. The picker must still list the app either
 * way — an empty dropdown is the one outcome that makes the action unusable.
 */
test("an app whose title cannot be read is still listed, under its own name", () => {
	const items = runRunning([regular({})], []);

	assert.equal(items.length, 1);
	assert.equal(items[0].title, "Slack", "falls back to the application name");
	assert.equal(items[0].path, "bundle:com.tinyspeck.slackmacgap");
});

test("the app list survives a window-server call that fails outright", () => {
	const items = runRunning([regular({})], [], () => {
		throw new Error("not permitted");
	});

	assert.deepEqual(
		items.map((i) => i.title),
		["Slack"],
		"titles are advisory; losing them must not empty the dropdown",
	);
});

test("a window list that arrives as an unusable ref costs titles, not the list", () => {
	// Whatever CoreGraphics hands back, a value that cannot be read must
	// degrade to no titles rather than throwing out of the whole script.
	const items = runRunning([regular({})], [], () => null);

	assert.deepEqual(
		items.map((i) => i.title),
		["Slack"],
	);
});

test("an app with no bundle location is skipped", () => {
	const items = runRunning([regular({ path: null })], []);
	assert.deepEqual(items, []);
});
