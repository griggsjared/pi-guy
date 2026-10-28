export type SearchResult = { title: string; url: string; snippet: string };

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	rsquo: "\u2019",
	lsquo: "\u2018",
	rdquo: "\u201D",
	ldquo: "\u201C",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	bull: "\u2022",
	middot: "\u00B7",
	deg: "\u00B0",
	copy: "\u00A9",
	times: "\u00D7",
};

// Single-pass decoder: a '&' produced by decoding '&amp;' is never re-scanned,
// matching cheerio semantics (no double-decode).
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const value = parseInt(entity.slice(2), 16);
			return Number.isNaN(value) || value > 0x10ffff ? match : String.fromCodePoint(value);
		}
		if (entity.startsWith("#")) {
			const value = parseInt(entity.slice(1), 10);
			return Number.isNaN(value) || value > 0x10ffff ? match : String.fromCodePoint(value);
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function stripTags(text: string): string {
	return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// DuckDuckGo lite wraps real URLs in //duckduckgo.com/l/?uddg=<encoded>&rut=... redirects.
// The href is entity-decoded first so the uddg value is bounded at a real '&', then
// percent-decoded exactly once (no URLSearchParams implicit decode).
function extractTargetUrl(rawHref: string): string {
	const href = decodeEntities(rawHref);
	const url = href.startsWith("//") ? `https:${href}` : href;
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "duckduckgo.com" || parsed.pathname !== "/l/") return url;
		const uddgMatch = parsed.search.match(/[?&]uddg=([^&]+)/);
		if (!uddgMatch) return url;
		try {
			return decodeURIComponent(uddgMatch[1] ?? "");
		} catch {
			return url;
		}
	} catch {
		return url;
	}
}

export function parseDuckDuckGoLite(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = anchorRe.exec(html)) !== null) {
		const tag = match[1] ?? "";
		if (!/class=['"]result-link['"]/.test(tag)) continue;
		const href = tag.match(/href=['"]([^'"]+)['"]/);
		if (!href) continue;
		const title = decodeEntities(stripTags(match[2] ?? ""));
		const url = extractTargetUrl(href[1] ?? "");
		const rest = html.slice(match.index + match[0].length);
		const snippetMatch = rest.match(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
		const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1] ?? "")) : "";
		if (title && url) results.push({ title, url, snippet });
	}
	return results;
}

const BLOCK_END_TAGS =
	/<\/(p|h1|h2|h3|h4|h5|h6|li|tr|td|th|dt|dd|blockquote|pre|ul|ol|dl|nav|header|footer|section|aside)>/gi;
export const MAX_TEXT_CHARS = 4000;

// Longest <tag>...</tag> region wins: pages nest <article> inside <main>, and
// both may appear multiple times (widgets, comments) — the biggest is the content.
function longestRegion(html: string, tag: string): string | undefined {
	const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
	let best: string | undefined;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html)) !== null) {
		const content = match[1] ?? "";
		if (!best || content.length > best.length) best = content;
	}
	return best;
}

function extractRegion(stripped: string): string {
	const article = longestRegion(stripped, "article");
	if (article) return article;
	const main = longestRegion(stripped, "main");
	if (main) return main;
	const body = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	return body ? (body[1] ?? "") : stripped;
}

// Drop a leading run of nav/boilerplate lines (language lists, TOC entries, nav
// items — all under ~45 chars, unlike real sentences) only when there are 5+ of
// them and the remaining text is non-trivial, so short intros are never eaten.
function stripBoilerplatePrefix(text: string): string {
	const lines = text.split("\n");
	let skip = 0;
	while (skip < lines.length && (lines[skip] ?? "").length < 45) skip++;
	if (skip < 5) return text;
	const remaining = lines.slice(skip).join("\n").trim();
	return remaining.length < 40 ? text : remaining;
}

// Zero-dependency readability extraction: prefers <article>/<main>, falls back
// to <body>, strips scripts/styles/svg/comments, and keeps paragraph breaks.
export function extractReadableContent(html: string): {
	title: string;
	description: string;
	text: string;
	charCount: number;
	truncated: boolean;
} {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeEntities(stripTags(titleMatch[1] ?? "")) : "";
	let description = "";
	const metaRe = /<meta\b[^>]*>/gi;
	for (const meta of html.matchAll(metaRe)) {
		if (!/name=["']description["']/i.test(meta[0]!)) continue;
		const content = meta[0]!.match(/content=["']([^"']*)["']/i);
		if (content) description = decodeEntities(content[1] ?? "");
		break;
	}
	const stripped = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template[\s\S]*?<\/template>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ");
	const region = extractRegion(stripped);
	const text = decodeEntities(
		region
			.replace(BLOCK_END_TAGS, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]*>/g, "")
			.replace(/[^\S\n]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{2,}/g, "\n")
			.trim(),
	);
	const cleaned = stripBoilerplatePrefix(text);
	const charCount = cleaned.length;
	let truncated = false;
	let finalText = cleaned;
	if (cleaned.length > MAX_TEXT_CHARS) {
		truncated = true;
		finalText = cleaned.slice(0, MAX_TEXT_CHARS);
		const lastSpace = finalText.lastIndexOf(" ");
		if (lastSpace > MAX_TEXT_CHARS * 0.75) finalText = finalText.slice(0, lastSpace);
		finalText = `${finalText.trimEnd()}\n…[truncated at ${charCount} characters]`;
	}
	return { title, description, text: finalText, charCount, truncated };
}

export function isWeakContent(html: string, text: string): boolean {
	if (text.length < 40) return true;
	const lower = html.toLowerCase();
	const jsShell =
		lower.includes("<script") && /id=["'](root|app|__next|__nuxt)["']/.test(lower);
	return (
		(jsShell && text.length < 200) ||
		/enable javascript|javascript required|please turn on javascript/i.test(html)
	);
}
