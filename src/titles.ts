/**
 * Line-wrapping for the titles the plugin puts on keys.
 *
 * Stream Deck draws a title on a single line and clips whatever doesn't fit
 * the key, so a name like "Microsoft Flight Simulator" loses both ends. It
 * does honour line breaks in a title, so the plugin breaks long names into
 * lines itself before setting them.
 *
 * Nothing here can measure the real rendering: Stream Deck draws the title,
 * and the plugin is never told how wide it came out. Widths are estimated from
 * Arial's character widths instead, which is close to how the default title
 * font renders, so narrow letters (i, l, t) and wide ones (m, W) are counted
 * for what they are rather than all as one average character.
 */

/**
 * Widest a line may be, in thousandths of the font size (em/1000, the unit
 * font metrics use): about 66 px of a 72 px key at the default title size,
 * leaving room for the outline Stream Deck draws round the text.
 * That is "Thunderbird" or "PowerShell" on one line; "Microsoft Edge" is not.
 */
export const TITLE_LINE_WIDTH = 5500;

/**
 * Most lines a title may take. Titles sit along the bottom of the key and grow
 * upwards, so every line covers more of the app's icon; a name that needs more
 * than this ends its last line with an ellipsis.
 */
export const TITLE_MAX_LINES = 3;

const ELLIPSIS = "…";

/** Arial's advance widths for printable ASCII, from space (32) to tilde (126). */
// prettier-ignore
const ASCII_WIDTHS = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, //  !"#$%&'()*+,-./
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 :;<=>?
	1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [\]^_
	333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z {|}~
];

/** Width of anything not otherwise known: an average letter. */
const DEFAULT_WIDTH = 556;

/** Full-width characters: CJK, Hangul, full-width forms, and emoji. */
const WIDE =
	/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

const segmenter =
	typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * The characters a person sees, so an accented letter or an emoji is never
 * split across two lines.
 */
function graphemes(text: string): string[] {
	return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

function charWidth(grapheme: string): number {
	const code = grapheme.codePointAt(0) ?? 0;
	if (code >= 32 && code <= 126) {
		return ASCII_WIDTHS[code - 32];
	}
	if (grapheme === ELLIPSIS || WIDE.test(grapheme)) {
		return 1000;
	}
	if (grapheme === "\u2018" || grapheme === "\u2019") {
		return 222;
	}
	// An accented Latin letter is as wide as the letter it is built on.
	const base = grapheme.normalize("NFD").codePointAt(0) ?? 0;
	if (base >= 32 && base <= 126) {
		return ASCII_WIDTHS[base - 32];
	}
	return DEFAULT_WIDTH;
}

/** Estimated width of a line of title text, in em/1000. */
export function titleWidth(text: string): number {
	let width = 0;
	for (const g of graphemes(text)) {
		width += charWidth(g);
	}
	return width;
}

/** One unbreakable run of a title, and what joins it to the run before. */
type Piece = { text: string; joiner: "" | " " };

/**
 * Where a word that is too wide for a line may break without losing anything:
 * after a separator (`-`, `_`, `.`, ...), before a bracket, where camelCase
 * starts a new word, and between letters and digits. These are the natural
 * joins in app names and file names — "Counter-Strike", "my_holiday_photos",
 * "DaVinciResolve", "Report2024.xlsx".
 */
const WORD_BREAK =
	/(?<=[-_.,+&/\\])(?=.)|(?=[([{])|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{Nd})|(?<=\p{Nd})(?=\p{L})/u;

/**
 * Splits a run with no natural break into pieces that each fit a line, as
 * evenly as possible: "Thunderbirds" is just too wide for one line, and
 * becomes "Thund" / "erbirds" rather than a full line and a scrap of two
 * letters.
 */
function splitEvenly(text: string, lineWidth: number): string[] {
	const chars = graphemes(text);
	let widthLeft = chars.reduce((sum, g) => sum + charWidth(g), 0);
	let piecesLeft = Math.ceil(widthLeft / lineWidth);
	const pieces: string[] = [];
	let current = "";
	let currentWidth = 0;

	for (const g of chars) {
		const w = charWidth(g);
		const target = widthLeft / piecesLeft;
		// Cut once this character would carry the piece past the line, or
		// once more than half of it lies beyond this piece's fair share.
		if (current && (currentWidth + w > lineWidth || (piecesLeft > 1 && currentWidth + w / 2 > target))) {
			pieces.push(current);
			widthLeft -= currentWidth;
			piecesLeft = Math.max(1, piecesLeft - 1);
			current = "";
			currentWidth = 0;
		}
		current += g;
		currentWidth += w;
	}
	if (current) {
		pieces.push(current);
	}
	return pieces;
}

/**
 * Breaks a title into the runs a line may end after. Words are kept whole;
 * only a word too wide for a line on its own is broken, at its natural joins
 * first and, failing those, evenly between letters.
 */
function toPieces(text: string, lineWidth: number): Piece[] {
	const pieces: Piece[] = [];
	for (const word of text.split(" ")) {
		const parts =
			titleWidth(word) <= lineWidth
				? [word]
				: word
						.split(WORD_BREAK)
						.filter((part) => part.length > 0)
						.flatMap((part) => (titleWidth(part) <= lineWidth ? [part] : splitEvenly(part, lineWidth)));
		parts.forEach((part, i) => pieces.push({ text: part, joiner: i === 0 && pieces.length > 0 ? " " : "" }));
	}
	return pieces;
}

/** Text of a run of pieces as one line: the first piece's joiner is the line break. */
function joinPieces(pieces: Piece[]): string {
	return pieces.map((p, i) => (i === 0 ? p.text : p.joiner + p.text)).join("");
}

/**
 * Shortens text to fit a line with an ellipsis on the end, for a title that
 * still had more to say when it ran out of lines.
 */
function withEllipsis(text: string, lineWidth: number): string {
	const chars = graphemes(text);
	const room = lineWidth - charWidth(ELLIPSIS);
	let width = 0;
	let kept = 0;
	while (kept < chars.length && width + charWidth(chars[kept]) <= room) {
		width += charWidth(chars[kept]);
		kept++;
	}
	return chars.slice(0, kept).join("").trimEnd() + ELLIPSIS;
}

/**
 * The title to put on a key for a name: the name itself when it fits one
 * line, otherwise the name broken into lines ("Microsoft\nFlight\nSimulator").
 *
 * Lines break between words wherever possible. A single word too wide for the
 * key breaks at its natural joins, and only as a last resort between letters;
 * either way no character is added or dropped, so the key still shows the
 * name exactly. Only a name too long for every line ends in an ellipsis.
 */
export function wrapTitle(name: string, lineWidth = TITLE_LINE_WIDTH, maxLines = TITLE_MAX_LINES): string {
	const text = name.replace(/\s+/g, " ").trim();
	if (!text || titleWidth(text) <= lineWidth) {
		return text;
	}

	const pieces = toPieces(text, lineWidth);
	const lines: string[] = [];
	let start = 0;
	while (start < pieces.length) {
		if (lines.length >= Math.max(1, maxLines) - 1) {
			// The last line allowed: everything left goes on it, cut short if
			// it doesn't fit.
			const rest = joinPieces(pieces.slice(start));
			lines.push(titleWidth(rest) <= lineWidth ? rest : withEllipsis(rest, lineWidth));
			break;
		}

		let end = start + 1;
		let line = pieces[start].text;
		while (end < pieces.length) {
			const longer = line + pieces[end].joiner + pieces[end].text;
			if (titleWidth(longer) > lineWidth) {
				break;
			}
			line = longer;
			end++;
		}
		lines.push(line);
		start = end;
	}
	return lines.join("\n");
}
