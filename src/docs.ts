import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
} from "node:path";

import type { CondorErrHandler } from "./db";

export interface DocEntry {
	path: string;
	size: number;
	mtime: number;
}

// Normalize a user-supplied relative directory into a forward-slash
// prefix with no trailing "/" — shared by listDocs, grepDocs, and
// renderIndex to keep returned paths consistent cross-platform.
function normalizePrefix(relDir: string): string {
	return relDir ? relDir.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

// The problem is a caller-supplied relative path could escape the
// store directory via ".." segments, absolute paths, or null bytes.
// The way we solve this is by resolving both paths and checking the
// target sits inside the store root using path.relative. When
// allowRoot is false (file ops) an empty or equal-to-root result is
// rejected because a file path must name something below the root;
// listDocs passes allowRoot=true so it can walk the store itself.
function resolveDocTarget(
	storeDir: string,
	rel: string,
	allowRoot: boolean
): string | null {
	if (typeof rel !== "string") return null;
	if (!allowRoot && !rel) return null;
	if (rel.includes("\0")) return null;
	if (isAbsolute(rel)) return null;
	const base = resolve(storeDir);
	const target = rel ? resolve(base, rel) : base;
	const r = relative(base, target);
	if ((!allowRoot && !r) || r.startsWith("..") || isAbsolute(r)) return null;
	return target;
}

// The problem is LLM chats, agent memory, and similar evolving text
// documents need id-addressed (not hash-addressed) storage with
// human-navigable paths.
// The way we solve this is by writing utf8 content atomically via
// temp-file + rename under {storeDir}/{relPath}, auto-creating
// parent directories and rejecting path-traversal escapes before
// any fs access.
// flow: user code -> putDoc() <-- HERE
export async function putDoc(
	relPath: string,
	content: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<boolean> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) {
		onErrors({
			code: "INVALID_PATH",
			message: `putDoc: invalid path '${relPath}'`,
		});
		return false;
	}
	// Write to a pid/time-scoped tmp file and rename into place so a
	// crash mid-write cannot leave a partial doc at the final path.
	const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
	try {
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(tmp, content, "utf8");
		await rename(tmp, abs);
		return true;
	} catch (err: any) {
		try {
			await unlink(tmp);
		} catch {
			// ignore cleanup errors
		}
		onErrors({
			code: err.code,
			message: `putDoc: ${err.message || String(err)}`,
			err,
		});
		return false;
	}
}

// The problem is chats and logs grow turn-by-turn; rewriting the
// whole document on every append wastes IO and widens the partial-
// write window.
// The way we solve this is by opening in append mode, writing, and
// fsyncing before close so the caller sees durable state on return.
// flow: user code -> appendDoc() <-- HERE
export async function appendDoc(
	relPath: string,
	content: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<boolean> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) {
		onErrors({
			code: "INVALID_PATH",
			message: `appendDoc: invalid path '${relPath}'`,
		});
		return false;
	}
	try {
		await mkdir(dirname(abs), { recursive: true });
		const fh = await open(abs, "a");
		try {
			await fh.write(content, null, "utf8");
			await fh.sync();
		} finally {
			await fh.close();
		}
		return true;
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `appendDoc: ${err.message || String(err)}`,
			err,
		});
		return false;
	}
}

// The problem is callers holding a doc path need the text back.
// The way we solve this is by reading the file as utf8 after the
// same path validation used on write.
// flow: user code -> getDoc() <-- HERE
export async function getDoc(
	relPath: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<string | null> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) {
		onErrors({
			code: "INVALID_PATH",
			message: `getDoc: invalid path '${relPath}'`,
		});
		return null;
	}
	try {
		return await readFile(abs, "utf8");
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `getDoc: ${err.message}`,
			err,
		});
		return null;
	}
}

// Cheap existence probe. Returns false on any error including bad
// path — callers use this to branch, not to surface failures.
// flow: user code -> hasDoc() <-- HERE
export async function hasDoc(
	relPath: string,
	storeDir: string
): Promise<boolean> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) return false;
	try {
		const st = await stat(abs);
		return st.isFile();
	} catch {
		return false;
	}
}

// The problem is compaction and "extract latest memories" flows
// need to enumerate every document under a subtree along with its
// size and freshness.
// The way we solve this is by recursively walking relDir (or the
// whole store when relDir is "") and returning one DocEntry per
// file with its forward-slashed relative path, byte size, and mtime.
// Understand: a missing relDir reports as an empty list, not an
// error — "no docs here yet" is a routine state for a fresh store.
// flow: user code -> listDocs() <-- HERE
export async function listDocs(
	relDir: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<DocEntry[] | null> {
	const abs = resolveDocTarget(storeDir, relDir, true);
	if (abs === null) {
		onErrors({
			code: "INVALID_PATH",
			message: `listDocs: invalid path '${relDir}'`,
		});
		return null;
	}
	try {
		const out: DocEntry[] = [];
		const prefix = normalizePrefix(relDir);
		await walk(abs, prefix, out);
		return out;
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `listDocs: ${err.message || String(err)}`,
			err,
		});
		return null;
	}
}

// Recursive walker for listDocs. Emits files only; directories are
// descended but never returned. Per-entry ENOENT is tolerated so a
// file deleted between readdir and stat just drops from the result
// instead of aborting the whole walk.
async function walk(
	absDir: string,
	relPrefix: string,
	out: DocEntry[]
): Promise<void> {
	let entries;
	try {
		entries = await readdir(absDir, { withFileTypes: true });
	} catch (err: any) {
		if (err.code === "ENOENT") return;
		throw err;
	}
	for (const entry of entries) {
		const absChild = join(absDir, entry.name);
		const relChild = relPrefix
			? posix.join(relPrefix, entry.name)
			: entry.name;
		if (entry.isDirectory()) {
			await walk(absChild, relChild, out);
		} else if (entry.isFile()) {
			try {
				const st = await stat(absChild);
				out.push({
					path: relChild,
					size: st.size,
					mtime: st.mtimeMs,
				});
			} catch (err: any) {
				if (err.code !== "ENOENT") throw err;
			}
		}
	}
}

// The problem is compaction and cleanup flows need to remove
// individual documents.
// The way we solve this is by unlinking the file after path
// validation; missing files surface via onErrors so callers know
// whether the delete actually happened.
// flow: user code -> deleteDoc() <-- HERE
export async function deleteDoc(
	relPath: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<boolean> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) {
		onErrors({
			code: "INVALID_PATH",
			message: `deleteDoc: invalid path '${relPath}'`,
		});
		return false;
	}
	try {
		await unlink(abs);
		return true;
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `deleteDoc: ${err.message}`,
			err,
		});
		return false;
	}
}

// The problem is archive/compaction flows (e.g. moving an old
// session under archive/YYYY-MM/) need to relocate a doc without
// a read+write+delete round-trip.
// The way we solve this is by validating both paths, creating the
// destination parent directory, and calling fs.rename for an atomic
// same-filesystem move. Cross-device renames surface as EXDEV via
// onErrors; callers can fall back to copy-then-delete if needed.
// flow: user code -> renameDoc() <-- HERE
export async function renameDoc(
	fromPath: string,
	toPath: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<boolean> {
	const from = resolveDocTarget(storeDir, fromPath, false);
	const to = resolveDocTarget(storeDir, toPath, false);
	if (!from || !to) {
		onErrors({
			code: "INVALID_PATH",
			message: `renameDoc: invalid path ${!from ? `from='${fromPath}'` : `to='${toPath}'`}`,
		});
		return false;
	}
	try {
		await mkdir(dirname(to), { recursive: true });
		await rename(from, to);
		return true;
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `renameDoc: ${err.message || String(err)}`,
			err,
		});
		return false;
	}
}

// The problem is loading a whole 2000-line session transcript just
// to read 20 relevant lines blows Urim's context budget. Agents
// need line-range reads the way MemGPT's memory_get does.
// The way we solve this is by reading the file, splitting on "\n",
// and slicing the requested 1-indexed inclusive range. Out-of-range
// from/to values clamp silently so callers can pass generous bounds
// without first stat-ing the file.
// flow: user code -> getDocLines() <-- HERE
export async function getDocLines(
	relPath: string,
	from: number,
	to: number,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<string | null> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) {
		onErrors({
			code: "INVALID_PATH",
			message: `getDocLines: invalid path '${relPath}'`,
		});
		return null;
	}
	try {
		const content = await readFile(abs, "utf8");
		const lines = content.split("\n");
		// Drop the trailing empty string produced by files ending in
		// "\n" so line counts match what editors show.
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const start = Math.max(1, from) - 1;
		const end = Math.min(lines.length, to);
		if (start >= end) return "";
		return lines.slice(start, end).join("\n");
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `getDocLines: ${err.message}`,
			err,
		});
		return null;
	}
}

export interface Frontmatter {
	[key: string]: string | string[];
}

// The problem is callers want to attach a summary, tag list, or
// theme to a doc without a sidecar file or separate metadata API.
// The way we solve this is by parsing a YAML-ish frontmatter block
// at the top of the doc — delimited by "---" on its own line — with
// scalar "key: value" pairs and inline arrays "key: [a, b]".
// Understand: this is a strict tiny subset of YAML, not a full
// parser. Nested maps and block-list syntax are out of scope. Both
// LF and CRLF line endings are accepted so Windows-authored docs
// parse correctly.
// flow: user code -> parseFrontmatter() <-- HERE
export function parseFrontmatter(
	content: string
): { meta: Frontmatter; body: string } {
	let nl: string;
	if (content.startsWith("---\n")) nl = "\n";
	else if (content.startsWith("---\r\n")) nl = "\r\n";
	else return { meta: {}, body: content };
	const openLen = 3 + nl.length;
	const fence = `${nl}---`;
	const close = content.indexOf(fence, openLen);
	if (close === -1) return { meta: {}, body: content };
	// The closing fence must sit on its own line — either at EOF or
	// followed by a newline — to avoid matching "---" embedded in a
	// value.
	const after = close + fence.length;
	if (
		after !== content.length &&
		content[after] !== "\n" &&
		content[after] !== "\r"
	) {
		return { meta: {}, body: content };
	}
	let bodyStart = after;
	if (content[bodyStart] === "\r") bodyStart++;
	if (content[bodyStart] === "\n") bodyStart++;
	const header = content.slice(openLen, close);
	const body = content.slice(bodyStart);
	const meta: Frontmatter = {};
	for (const raw of header.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const val = line.slice(colon + 1).trim();
		if (!key) continue;
		if (val.startsWith("[") && val.endsWith("]")) {
			meta[key] = val
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
		} else {
			meta[key] = val.replace(/^["']|["']$/g, "");
		}
	}
	return { meta, body };
}

export interface DocMatch {
	path: string;
	line: number;
	text: string;
}

export interface GrepOpts {
	regex?: boolean;
	caseInsensitive?: boolean;
	maxResults?: number;
}

// The problem is Urim's signature move ("you mentioned your sister
// three times this week") needs a single fast call that scans every
// session transcript for a phrase.
// The way we solve this is by walking relDir, reading each file,
// and testing every line against a substring or compiled regex.
// Matches surface as { path, line, text } in path-then-line order so
// callers get stable output.
// Understand: Letta's 2025 benchmark showed plain text search over
// a flat file tree outperforms vector memory on LoCoMo. No
// embeddings — deliberate, not a shortcut.
// flow: user code -> grepDocs() <-- HERE
export async function grepDocs(
	pattern: string,
	relDir: string,
	storeDir: string,
	onErrors: CondorErrHandler,
	opts?: GrepOpts
): Promise<DocMatch[] | null> {
	const abs = resolveDocTarget(storeDir, relDir, true);
	if (abs === null) {
		onErrors({
			code: "INVALID_PATH",
			message: `grepDocs: invalid path '${relDir}'`,
		});
		return null;
	}
	if (typeof pattern !== "string" || !pattern) {
		onErrors({
			code: "INVALID_PATTERN",
			message: `grepDocs: empty pattern`,
		});
		return null;
	}
	let re: RegExp | null = null;
	let needle = pattern;
	if (opts?.regex) {
		try {
			re = new RegExp(pattern, opts.caseInsensitive ? "i" : "");
		} catch (err: any) {
			onErrors({
				code: "INVALID_PATTERN",
				message: `grepDocs: bad regex '${pattern}': ${err.message}`,
				err,
			});
			return null;
		}
	} else if (opts?.caseInsensitive) {
		needle = pattern.toLowerCase();
	}
	const max = opts?.maxResults ?? Infinity;
	const prefix = normalizePrefix(relDir);
	const entries: DocEntry[] = [];
	try {
		await walk(abs, prefix, entries);
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `grepDocs: ${err.message || String(err)}`,
			err,
		});
		return null;
	}
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const out: DocMatch[] = [];
	const storeAbs = resolve(storeDir);
	for (const entry of entries) {
		if (out.length >= max) break;
		// entry.path was produced by walk() rooted at storeAbs, so it is
		// already safe — no need to re-validate via resolveDocTarget.
		const absFile = join(storeAbs, entry.path);
		let content: string;
		try {
			content = await readFile(absFile, "utf8");
		} catch (err: any) {
			if (err.code === "ENOENT") continue;
			onErrors({
				code: err.code,
				message: `grepDocs/read ${entry.path}: ${err.message}`,
				err,
			});
			continue;
		}
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (out.length >= max) break;
			const text = lines[i]!;
			const hit = re
				? re.test(text)
				: opts?.caseInsensitive
					? text.toLowerCase().includes(needle)
					: text.includes(needle);
			if (hit) out.push({ path: entry.path, line: i + 1, text });
		}
	}
	return out;
}

export interface IndexOpts {
	recursive?: boolean;
}

// Skip the generated index file itself so writeIndex doesn't list
// itself and so renderIndex output stays clean.
const INDEX_FILENAME = "INDEX.md";

// The problem is an agent browsing the memory tree needs a single
// scannable view of what's in a directory — path, size, freshness,
// and (if present) a caller-supplied summary — before deciding
// which docs to load into context.
// The way we solve this is by listing entries under relDir and
// rendering them as a markdown table. Summaries are read from each
// doc's frontmatter "summary:" field; docs without frontmatter
// simply show an empty summary column. INDEX.md files are excluded
// from the listing to avoid self-reference.
// flow: user code -> renderIndex() <-- HERE
export async function renderIndex(
	relDir: string,
	storeDir: string,
	onErrors: CondorErrHandler,
	opts?: IndexOpts
): Promise<string | null> {
	const abs = resolveDocTarget(storeDir, relDir, true);
	if (abs === null) {
		onErrors({
			code: "INVALID_PATH",
			message: `renderIndex: invalid path '${relDir}'`,
		});
		return null;
	}
	const prefix = normalizePrefix(relDir);
	const all: DocEntry[] = [];
	try {
		await walk(abs, prefix, all);
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `renderIndex: ${err.message || String(err)}`,
			err,
		});
		return null;
	}
	// Filter: always drop INDEX.md; if non-recursive, drop anything
	// deeper than relDir.
	const recursive = opts?.recursive ?? false;
	const filtered = all.filter((e) => {
		if (posix.basename(e.path) === INDEX_FILENAME) return false;
		if (!recursive) {
			const rest = prefix ? e.path.slice(prefix.length + 1) : e.path;
			if (rest.includes("/")) return false;
		}
		return true;
	});
	filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const rows: string[] = [];
	for (const entry of filtered) {
		const summary = await extractSummary(storeDir, entry.path);
		rows.push(
			`| ${entry.path} | ${formatSize(entry.size)} | ${formatDate(entry.mtime)} | ${escapeCell(summary)} |`
		);
	}
	const title = prefix ? `# Index: ${prefix}` : "# Index";
	const header = "| Path | Size | Modified | Summary |";
	const sep = "|------|------|----------|---------|";
	return [title, "", header, sep, ...rows].join("\n") + "\n";
}

// The problem is some consumers (git diffs, plain-file readers) can
// only see files on disk — they cannot call a virtual renderIndex.
// The way we solve this is by generating the same markdown and
// writing it to {relDir}/INDEX.md via putDoc so the index is a real,
// commitable artifact. Opt-in — callers choose when to persist.
// flow: user code -> writeIndex() <-- HERE
export async function writeIndex(
	relDir: string,
	storeDir: string,
	onErrors: CondorErrHandler,
	opts?: IndexOpts
): Promise<boolean> {
	const rendered = await renderIndex(relDir, storeDir, onErrors, opts);
	if (rendered === null) return false;
	const p = normalizePrefix(relDir);
	const target = p ? `${p}/${INDEX_FILENAME}` : INDEX_FILENAME;
	return await putDoc(target, rendered, storeDir, onErrors);
}

// The problem is renderIndex needs a summary per doc without
// buffering every (potentially multi-MB) file into memory just to
// read its frontmatter header.
// The way we solve this is by opening the file and reading a fixed
// 4 KB head — enough to cover any realistic frontmatter — then
// parsing that slice. Missing file, missing frontmatter, or missing
// summary field all resolve to "" so renderIndex can keep going.
const SUMMARY_HEAD_BYTES = 4096;
async function extractSummary(
	storeDir: string,
	relPath: string
): Promise<string> {
	const abs = resolveDocTarget(storeDir, relPath, false);
	if (!abs) return "";
	let fh: any;
	try {
		fh = await open(abs, "r");
		const buf = Buffer.alloc(SUMMARY_HEAD_BYTES);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		const head = buf.slice(0, bytesRead).toString("utf8");
		const { meta } = parseFrontmatter(head);
		const s = meta.summary;
		return typeof s === "string" ? s : "";
	} catch {
		return "";
	} finally {
		if (fh) {
			try {
				await fh.close();
			} catch {
				// ignore close errors
			}
		}
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// Escape pipe and newline so a markdown table row stays on one line.
function escapeCell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
