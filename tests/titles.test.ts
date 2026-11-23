import assert from "node:assert/strict";
import { test } from "node:test";

import { TITLE_LINE_WIDTH, TITLE_MAX_LINES, titleWidth, wrapTitle } from "../src/titles.ts";

/** The title's lines, for asserting on. */
const lines = (name: string, width?: number, maxLines?: number) => wrapTitle(name, width, maxLines).split("\n");

/* ------------------------------- measuring -------------------------------- */

test("narrow and wide letters are measured for what they are", () => {
	assert.ok(titleWidth("iiii") < titleWidth("nnnn"));
	assert.ok(titleWidth("nnnn") < titleWidth("WWWW"));
	assert.equal(titleWidth(""), 0);
});

test("an accented letter is as wide as its plain letter, and CJK is full width", () => {
	assert.equal(titleWidth("Café"), titleWidth("Cafe"));
	assert.equal(titleWidth("原神"), 2000);
});

/* -------------------------------- wrapping -------------------------------- */

test("a name that fits one line is left alone", () => {
	for (const name of ["Spotify", "Steam", "Thunderbird", "PowerShell", "OBS Studio", "holiday.png"]) {
		assert.equal(wrapTitle(name), name);
	}
});

test("a long name breaks between words", () => {
	assert.equal(wrapTitle("Microsoft Edge"), "Microsoft\nEdge");
	assert.equal(wrapTitle("Google Chrome"), "Google\nChrome");
	assert.equal(wrapTitle("Microsoft Flight Simulator"), "Microsoft\nFlight\nSimulator");
});

test("words that fit together share a line", () => {
	assert.equal(wrapTitle("Epic Games Launcher"), "Epic Games\nLauncher");
	assert.equal(wrapTitle("League of Legends"), "League of\nLegends");
});

test("a word is never split while it fits a line of its own", () => {
	// DaVinci has a camelCase join, but the whole word fits, so it stays whole.
	assert.equal(wrapTitle("Open DaVinci Resolve"), "Open\nDaVinci\nResolve");
});

test("runs of whitespace count as one space", () => {
	assert.equal(wrapTitle("  Microsoft \t  Edge  "), "Microsoft\nEdge");
	assert.equal(wrapTitle("  Steam  "), "Steam");
	assert.equal(wrapTitle("   "), "");
});

/* ---------------------------- over-long words ----------------------------- */

test("a word too wide for a line breaks at a hyphen, underscore or dot, keeping it", () => {
	assert.equal(wrapTitle("Counter-Strike 2"), "Counter-\nStrike 2");
	assert.equal(wrapTitle("MyGame.uproject"), "MyGame.\nuproject");
	assert.equal(wrapTitle("my_long_file_name_final.txt"), "my_long_\nfile_name_\nfinal.txt");
});

test("a word too wide for a line breaks where camelCase starts a new word", () => {
	assert.equal(wrapTitle("DaVinciResolve"), "DaVinci\nResolve");
	assert.equal(wrapTitle("WindowsTerminalPreview"), "Windows\nTerminal\nPreview");
	// An acronym stays together, and the word after it starts at its capital.
	assert.deepEqual(lines("XMLParser", 3500), ["XML", "Parser"]);
});

test("a word too wide for a line breaks between letters and digits", () => {
	assert.deepEqual(lines("Report2024", 3200), ["Report", "2024"]);
});

test("a word with no natural break is split evenly, without adding or dropping anything", () => {
	assert.equal(wrapTitle("Thunderbirds"), "Thund\nerbirds");
	const split = lines("Supercalifragilisticexpialidocious");
	assert.equal(split.length, 3);
	assert.equal(split.join(""), "Supercalifragilisticexpialidocious");
	// Even pieces: none is less than half as wide as another.
	const widths = split.map(titleWidth);
	assert.ok(Math.min(...widths) * 2 > Math.max(...widths), `uneven pieces: ${split.join(" / ")}`);
});

test("an emoji or accented letter is never split in two", () => {
	const name = "é".normalize("NFD").repeat(30);
	for (const line of lines(name)) {
		assert.ok(!/^\u0301/.test(line), "a line starts with a stray combining accent");
	}
	assert.equal(lines("👍".repeat(12)).join(""), "👍".repeat(12));
});

/* ------------------------------ running out ------------------------------- */

test("a name too long for every line ends the last line with an ellipsis", () => {
	assert.equal(wrapTitle("Microsoft Visual Studio Community Edition 2022"), "Microsoft\nVisual\nStudio Co…");
	assert.equal(wrapTitle("Microsoft Teams (work or school)"), "Microsoft\nTeams\n(work or s…");
});

test("the number of lines can be capped", () => {
	assert.equal(wrapTitle("Microsoft Flight Simulator", undefined, 2), "Microsoft\nFlight Sim…");
	assert.equal(wrapTitle("Microsoft Edge", undefined, 1), "Microsoft…");
});

test("every line fits and no title takes more lines than allowed", () => {
	const names = [
		"Visual Studio Code",
		"Adobe Photoshop 2025",
		"Quarterly Report 2024.xlsx",
		"Call of Duty: Modern Warfare III",
		"Red Dead Redemption 2",
		"XMLParserConfiguration.json",
		"原神 インパクト ゲーム ランチャー",
		"a".repeat(200),
		"W".repeat(40),
		"Café Société Résumé Naïveté",
		"C:\\Users\\Dean\\Documents\\Unreal Projects\\MyGame\\MyGame.uproject",
	];
	for (const name of names) {
		const result = lines(name);
		assert.ok(result.length <= TITLE_MAX_LINES, `${name}: ${result.length} lines`);
		for (const line of result) {
			assert.ok(line.length > 0, `${name}: empty line`);
			assert.ok(titleWidth(line) <= TITLE_LINE_WIDTH, `${name}: "${line}" is too wide`);
		}
		// Unless it ran out of room, the title is the name, every character kept.
		if (!result[result.length - 1].endsWith("…")) {
			assert.equal(result.join("").replace(/ /g, ""), name.replace(/ /g, ""));
		}
	}
});
