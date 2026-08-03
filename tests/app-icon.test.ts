import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { toAppIconResult, type RawAppIcon } from "../src/platform/icons.ts";
import { ICON_MAX_PX } from "../src/platform/types.ts";
import { buildAppIconScript, runPowerShell } from "../src/platform/windows/powershell.ts";

/**
 * The icon script is exercised against real .ico files written to a temp
 * folder, because the parts worth testing — which of several icons is chosen,
 * and whether the frame actually decodes — only exist once PowerShell and
 * System.Drawing have run. Fixtures are built here rather than checked in so
 * each case states its own sizes and frame format.
 */

/** Builds the 22-byte header + directory entry a single-frame .ico begins with. */
function icoDirectory(size: number, bits: number, frameLength: number): Buffer {
	const dir = Buffer.alloc(22);
	dir.writeUInt16LE(0, 0); // reserved
	dir.writeUInt16LE(1, 2); // type: icon
	dir.writeUInt16LE(1, 4); // one frame
	// 256 is stored as 0: the field is a single byte.
	dir.writeUInt8(size >= 256 ? 0 : size, 6);
	dir.writeUInt8(size >= 256 ? 0 : size, 7);
	dir.writeUInt16LE(1, 10); // colour planes
	dir.writeUInt16LE(bits, 12);
	dir.writeUInt32LE(frameLength, 14);
	dir.writeUInt32LE(22, 18); // the frame follows the directory
	return dir;
}

/**
 * A single-frame .ico holding an uncompressed 32bpp DIB — the layout every
 * Windows icon used before Vista, and the branch that goes through
 * System.Drawing.Icon.
 */
function dibIco(size: number): Buffer {
	const pixels = Buffer.alloc(size * size * 4);
	for (let i = 0; i < size * size; i++) {
		pixels[i * 4 + 0] = 0x20; // B
		pixels[i * 4 + 1] = 0x40; // G
		pixels[i * 4 + 2] = 0x80; // R
		pixels[i * 4 + 3] = 0xff; // A
	}
	// The AND mask is 1 bit per pixel, rows padded to 4 bytes; all-zero is
	// "every pixel opaque".
	const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);

	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0); // biSize
	header.writeInt32LE(size, 4); // biWidth
	header.writeInt32LE(size * 2, 8); // biHeight: colour plane plus mask
	header.writeUInt16LE(1, 12); // biPlanes
	header.writeUInt16LE(32, 14); // biBitCount
	header.writeUInt32LE(0, 16); // biCompression: BI_RGB
	header.writeUInt32LE(pixels.length, 20); // biSizeImage

	const frame = Buffer.concat([header, pixels, mask]);
	return Buffer.concat([icoDirectory(size, 32, frame.length), frame]);
}

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A minimal 8-bit RGBA PNG, uniform colour, no interlacing. */
function png(size: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(6, 9); // colour type: RGBA

	// Each scanline carries a leading filter byte; 0 is "no filter".
	const raw = Buffer.alloc(size * (size * 4 + 1));
	let offset = 0;
	for (let y = 0; y < size; y++) {
		raw[offset++] = 0;
		for (let x = 0; x < size; x++) {
			raw[offset++] = 0x80;
			raw[offset++] = 0x40;
			raw[offset++] = 0x20;
			raw[offset++] = 0xff;
		}
	}

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** A single-frame .ico whose frame is a whole PNG file, as Vista introduced. */
function pngIco(size: number): Buffer {
	const frame = png(size);
	return Buffer.concat([icoDirectory(size, 32, frame.length), frame]);
}

/** Reads a returned PNG's IHDR, proving it is a PNG and not merely a string. */
function pngDimensions(base64: string): { width: number; height: number } {
	const buffer = Buffer.from(base64, "base64");
	assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, "the reply is not a PNG");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** A throwaway folder holding an app's files, cleaned up when the test ends. */
function appFolder(t: { after(fn: () => void): void }, files: Record<string, Buffer>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "snap-icon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(dir, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	return dir;
}

function findIcon(appPath: string): Promise<RawAppIcon> {
	return runPowerShell<RawAppIcon>(buildAppIconScript(appPath), 30_000);
}

test("a DIB icon beside the executable is found and decoded", async (t) => {
	const dir = appFolder(t, { "Signal.ico": dibIco(64) });

	const result = await findIcon(path.join(dir, "Signal.exe"));

	assert.equal(result.ok, true);
	assert.equal(result.found, true);
	assert.equal(result.path, path.join(dir, "Signal.ico"));
	assert.equal(result.width, 64);
	assert.equal(result.height, 64);
	assert.deepEqual(pngDimensions(result.png as string), { width: 64, height: 64 });
});

test("a PNG-compressed frame is decoded, and 256px is scaled down to the key size", async (t) => {
	const dir = appFolder(t, { "app.ico": pngIco(256) });

	const result = await findIcon(path.join(dir, "Whatever.exe"));

	assert.equal(result.found, true);
	// The reported size is the frame's own, before the downscale...
	assert.equal(result.width, 256);
	// ...while the PNG that reaches the key is capped.
	assert.deepEqual(pngDimensions(result.png as string), { width: ICON_MAX_PX, height: ICON_MAX_PX });
});

test("an icon named after the executable beats every other candidate", async (t) => {
	const dir = appFolder(t, {
		// Deliberately the smallest, shallowest-tied and last alphabetically, so
		// only the name can be what selects it.
		"Signal.ico": dibIco(16),
		"app.ico": dibIco(64),
		"Random.ico": dibIco(128),
	});

	const result = await findIcon(path.join(dir, "Signal.exe"));

	assert.equal(result.path, path.join(dir, "Signal.ico"));
});

test("a conventional name is taken, however deep, and a shallower unrelated one is not", async (t) => {
	const dir = appFolder(t, {
		"Random.ico": dibIco(128),
		// Where Electron apps really put it — Signal's is five folders down.
		[path.join("resources", "app.asar.unpacked", "build", "icons", "win", "icon.ico")]: dibIco(32),
	});

	const result = await findIcon(path.join(dir, "Mystery.exe"));

	assert.equal(result.found, true);
	assert.equal(result.path, path.join(dir, "resources", "app.asar.unpacked", "build", "icons", "win", "icon.ico"));
});

test("an icon whose name has nothing to do with the app is never used", async (t) => {
	// System32 holds exactly one .ico, OneDrive's. A Notepad key must not wear it.
	const dir = appFolder(t, { "OneDrive.ico": dibIco(64) });

	const result = await findIcon(path.join(dir, "notepad.exe"));

	assert.equal(result.ok, true);
	assert.equal(result.found, false);
});

test("an app with neither an .ico nor an icon in its executable is a miss naming the file", async (t) => {
	const dir = appFolder(t, { "readme.txt": Buffer.from("no icons here") });

	const result = await findIcon(path.join(dir, "Bare.exe"));

	assert.equal(result.ok, true);
	assert.equal(result.found, false);
	assert.match(result.reason ?? "", /carries no icon of its own/);
	assert.ok((result.reason ?? "").includes("Bare.exe"), `reason should name the file: ${result.reason}`);
});

test("a Store app is reported as a miss rather than searched", async () => {
	const result = await findIcon("shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");

	assert.equal(result.ok, true);
	assert.equal(result.found, false);
	assert.match(result.reason ?? "", /Store apps/);
});

test("a file that only pretends to be an .ico is passed over for the next candidate", async (t) => {
	// Acrobat's Start Menu shortcut points at an "_SC_Acrobat.ico" that is
	// really a DLL, which must not cost the app its icon.
	const dir = appFolder(t, {
		"Broken.ico": Buffer.from("MZ this is a portable executable, not an icon"),
		"icon.ico": dibIco(48),
	});

	const result = await findIcon(path.join(dir, "Broken.exe"));

	assert.equal(result.found, true);
	assert.equal(result.path, path.join(dir, "icon.ico"));
});

test("when no candidate decodes, the miss explains why rather than failing the press", async (t) => {
	const dir = appFolder(t, { "Broken.ico": Buffer.from("not an icon at all") });

	const result = await findIcon(path.join(dir, "Broken.exe"));

	assert.equal(result.ok, true);
	assert.equal(result.found, false);
	// The junk .ico is passed over, then the executable that isn't there either.
	assert.match(result.reason ?? "", /carries no icon of its own/);
});

/* ------------------------- icons inside executables ------------------------ */

/**
 * An executable that is present on every Windows machine and certain to carry
 * an icon of its own. (Not every one does — powershell.exe, the interpreter
 * this suite shells out to, has no icon resources at all and takes the one on
 * its Start Menu shortcut instead.)
 */
const EXPLORER = path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");

test("an app that ships no .ico falls back to the icon compiled into its executable", async () => {
	const result = await findIcon(EXPLORER);

	assert.equal(result.ok, true);
	assert.equal(result.found, true, `expected an icon: ${result.reason}`);
	assert.equal(result.path, EXPLORER);
	// Whatever Windows build this is, the icon decodes and is a real square image.
	const rendered = pngDimensions(result.png as string);
	assert.ok(rendered.width >= 16 && rendered.width <= ICON_MAX_PX, `unexpected size ${rendered.width}`);
	assert.equal(rendered.width, rendered.height);
});

test("an .ico shipped beside the executable wins over the executable's own icon", async (t) => {
	// A real executable with a real icon, next to an authored .ico: both
	// sources are genuinely available, so only precedence decides.
	const dir = appFolder(t, {
		"explorer.exe": readFileSync(EXPLORER),
		"explorer.ico": dibIco(64),
	});

	const result = await findIcon(path.join(dir, "explorer.exe"));

	assert.equal(result.found, true, `expected an icon: ${result.reason}`);
	assert.equal(result.path, path.join(dir, "explorer.ico"));
	assert.equal(result.width, 64);
});

test("a 256px frame is decoded at 256, not at the next size down", async (t) => {
	// A 256-pixel frame records its dimensions as the byte 0, which
	// System.Drawing.Icon reads as zero and answers with the next size down —
	// the reason frames go through CreateIconFromResourceEx instead.
	const dir = appFolder(t, { "Big.ico": dibIco(256) });

	const result = await findIcon(path.join(dir, "Big.exe"));

	assert.equal(result.found, true, `expected an icon: ${result.reason}`);
	assert.equal(result.width, 256);
	assert.deepEqual(pngDimensions(result.png as string), { width: ICON_MAX_PX, height: ICON_MAX_PX });
});

test("a found icon becomes a data URI", () => {
	const result = toAppIconResult({
		ok: true,
		found: true,
		path: "C:\\apps\\Signal.ico",
		width: 256,
		height: 256,
		png: "QUJD",
	});

	assert.equal(result.found, true);
	assert.deepEqual(result.found ? result.icon : null, {
		sourcePath: "C:\\apps\\Signal.ico",
		width: 256,
		height: 256,
		image: "data:image/png;base64,QUJD",
	});
});

test("a miss keeps its reason, and a reasonless one still says something", () => {
	assert.deepEqual(toAppIconResult({ ok: true, found: false, reason: "Store apps ship no .ico file." }), {
		found: false,
		reason: "Store apps ship no .ico file.",
	});

	const bare = toAppIconResult({ ok: true, found: false });
	assert.equal(bare.found, false);
	assert.ok(!bare.found && bare.reason.length > 0);
});

test("a reply claiming success with no image is treated as a miss, not an empty icon", () => {
	// Handing Stream Deck "data:image/png;base64," would blank the key.
	assert.equal(toAppIconResult({ ok: true, found: true, png: "" }).found, false);
});

test("a failed script throws so the failure is logged rather than shown as no icon", () => {
	assert.throws(() => toAppIconResult({ ok: false, error: "PowerShell exploded" }), /PowerShell exploded/);
	assert.throws(() => toAppIconResult(null), /no usable result/);
});
