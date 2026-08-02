import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	applyPlatform,
	getPlatform,
	platformFromConnection,
} from "../com.bowerstudio.snap-launcher.sdPlugin/ui/platform.js";

/* ------------------------------- DOM test double --------------------------- */

type FakeEl = {
	classes: string[];
	hidden: boolean;
	attrs: Record<string, string>;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
};

function el(classes: string[], attrs: Record<string, string> = {}): FakeEl {
	return {
		classes,
		hidden: true,
		attrs: { ...attrs },
		getAttribute(name) {
			return name in this.attrs ? this.attrs[name] : null;
		},
		setAttribute(name, value) {
			this.attrs[name] = value;
		},
		removeAttribute(name) {
			delete this.attrs[name];
		},
	};
}

function fakeDoc(elements: FakeEl[]): Document {
	return {
		querySelectorAll(selector: string) {
			if (selector.startsWith(".")) {
				const wanted = selector.slice(1);
				return elements.filter((e) => e.classes.includes(wanted));
			}
			if (selector === "[data-accept-windows]") {
				return elements.filter((e) => "data-accept-windows" in e.attrs);
			}
			return [];
		},
	} as unknown as Document;
}

const FILE_ATTRS = { "data-accept-windows": ".exe,.lnk,.bat,.cmd", "data-accept-mac": ".app" };

function scenario() {
	const winBlock = el(["win-only"]);
	const macBlock = el(["mac-only"]);
	const filePicker = el(["source-browse"], { ...FILE_ATTRS });
	return { winBlock, macBlock, filePicker, doc: fakeDoc([winBlock, macBlock, filePicker]) };
}

/* --------------------------------- behavior -------------------------------- */

test("importing the module in Node does not touch the DOM", () => {
	assert.equal(typeof applyPlatform, "function");
	assert.equal(getPlatform(), null, "no platform is known outside the Property Inspector");
});

test("on Windows the Windows blocks are revealed and macOS blocks stay hidden", () => {
	const s = scenario();
	applyPlatform("windows", s.doc);

	assert.equal(s.winBlock.hidden, false, "the Virtual desktop section is shown on Windows");
	assert.equal(s.macBlock.hidden, true);
	assert.equal(s.filePicker.getAttribute("accept"), ".exe,.lnk,.bat,.cmd");
});

test("on macOS the Virtual desktop section is never revealed", () => {
	const s = scenario();
	applyPlatform("mac", s.doc);

	assert.equal(s.winBlock.hidden, true, "macOS Spaces have no equivalent, so the section stays hidden");
	assert.equal(s.macBlock.hidden, false);
	assert.equal(s.filePicker.getAttribute("accept"), ".app", "the picker offers application bundles");
});

test("an unknown platform leaves only the universally-supported controls", () => {
	const s = scenario();
	applyPlatform(null, s.doc);

	assert.equal(s.winBlock.hidden, true);
	assert.equal(s.macBlock.hidden, true);
	assert.equal(s.filePicker.getAttribute("accept"), null, "no filter rather than the wrong one");
});

/* --------------------------- markup ships hidden --------------------------- */

const uiDir = new URL("../com.bowerstudio.snap-launcher.sdPlugin/ui/", import.meta.url);

for (const page of ["launch.html", "close.html"]) {
	const html = readFileSync(new URL(page, uiDir), "utf8");

	test(`${page} ships every platform-specific block hidden, so nothing flashes`, () => {
		// Each class="...win-only..." / "...mac-only..." element must carry the
		// hidden attribute in the markup itself: the browser must never paint a
		// control that is about to be taken away.
		const blocks = html.match(/<[^>]*class="[^"]*(?:win-only|mac-only)[^"]*"[^>]*>/g) ?? [];
		assert.ok(blocks.length > 0, `${page} has platform-specific blocks`);
		for (const block of blocks) {
			assert.match(block, /\bhidden\b/, `not hidden by default in ${page}: ${block}`);
		}
	});

	test(`${page} loads the platform module`, () => {
		assert.match(html, /<script type="module" src="platform\.js"><\/script>/);
	});

	test(`${page} sets no static accept filter on the file picker`, () => {
		// A hard-coded accept would offer Windows file types on a Mac.
		assert.ok(!/<sdpi-file[^>]*\saccept=/.test(html), `${page} must let the platform decide the filter`);
		assert.match(html, /<sdpi-file[^>]*data-accept-windows="[^"]+"[^>]*data-accept-mac="[^"]+"/);
	});
}

test("the Virtual desktop section is Windows-only and keeps its setting", () => {
	const html = readFileSync(new URL("launch.html", uiDir), "utf8");
	const section = /<div class="win-only" hidden>[\s\S]*?<\/sdpi-item>/.exec(html);
	assert.ok(section, "the Virtual desktop block is win-only and hidden by default");
	assert.match(section[0], /setting="virtualDesktop"/);
});

/* --------------------------- connection payload ---------------------------- */

test("the platform is read from a wrapped registration payload", () => {
	assert.equal(platformFromConnection({ info: { application: { platform: "mac" } } }), "mac");
	assert.equal(platformFromConnection({ info: { application: { platform: "windows" } } }), "windows");
});

test("a bare registration payload is accepted too", () => {
	// getConnectionInfo is documented to carry the OS but not its exact shape.
	assert.equal(platformFromConnection({ application: { platform: "windows" } }), "windows");
});

test("an unrecognised payload yields no platform rather than a guess", () => {
	for (const payload of [
		null,
		undefined,
		{},
		{ info: {} },
		{ application: {} },
		{ info: { application: { platform: "linux" } } },
	]) {
		assert.equal(platformFromConnection(payload), null);
	}
});
