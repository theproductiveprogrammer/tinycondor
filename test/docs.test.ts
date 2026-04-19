import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import mockFs from "mock-fs";

import {
	putDoc,
	appendDoc,
	getDoc,
	hasDoc,
	listDocs,
	deleteDoc,
	renameDoc,
	getDocLines,
	grepDocs,
	renderIndex,
	writeIndex,
	parseFrontmatter,
} from "../src/docs";

const storeDir = "testdocs";

describe("Doc store", () => {
	let onErrors: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFs({});
		onErrors = vi.fn();
	});

	afterEach(() => {
		mockFs.restore();
	});

	it("putDoc writes utf8 content that getDoc roundtrips", async () => {
		const ok = await putDoc(
			"agents/planner/memory.md",
			"# Plan\n- step one",
			storeDir,
			onErrors
		);
		expect(ok).toBe(true);

		const got = await getDoc(
			"agents/planner/memory.md",
			storeDir,
			onErrors
		);
		expect(got).toBe("# Plan\n- step one");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("putDoc auto-creates parent directories and overwrites atomically", async () => {
		await putDoc("a/b/c.md", "v1", storeDir, onErrors);
		await putDoc("a/b/c.md", "v2", storeDir, onErrors);

		const got = await getDoc("a/b/c.md", storeDir, onErrors);
		expect(got).toBe("v2");

		// No stray tmp files left from the atomic-rename dance.
		const dirEntries = await fs.readdir(`${storeDir}/a/b`);
		expect(dirEntries).toEqual(["c.md"]);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("putDoc handles unicode content", async () => {
		await putDoc("note.md", "héllo 🌍", storeDir, onErrors);
		const got = await getDoc("note.md", storeDir, onErrors);
		expect(got).toBe("héllo 🌍");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("appendDoc appends to existing doc", async () => {
		await putDoc("chat.md", "turn 1\n", storeDir, onErrors);
		await appendDoc("chat.md", "turn 2\n", storeDir, onErrors);
		await appendDoc("chat.md", "turn 3\n", storeDir, onErrors);

		const got = await getDoc("chat.md", storeDir, onErrors);
		expect(got).toBe("turn 1\nturn 2\nturn 3\n");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("appendDoc creates the doc if it does not exist", async () => {
		const ok = await appendDoc("fresh.md", "hi", storeDir, onErrors);
		expect(ok).toBe(true);
		const got = await getDoc("fresh.md", storeDir, onErrors);
		expect(got).toBe("hi");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("getDoc on missing file returns null and reports an error", async () => {
		const got = await getDoc("nope.md", storeDir, onErrors);
		expect(got).toBeNull();
		expect(onErrors).toHaveBeenCalledTimes(1);
		expect(onErrors.mock.calls[0]![0]).toMatchObject({ code: "ENOENT" });
	});

	it("hasDoc reflects presence", async () => {
		await putDoc("here.md", "x", storeDir, onErrors);
		expect(await hasDoc("here.md", storeDir)).toBe(true);
		expect(await hasDoc("missing.md", storeDir)).toBe(false);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("hasDoc returns false for a directory path", async () => {
		await putDoc("a/b/c.md", "x", storeDir, onErrors);
		// "a/b" exists but is a directory, not a file.
		expect(await hasDoc("a/b", storeDir)).toBe(false);
	});

	it("deleteDoc removes the file", async () => {
		await putDoc("gone.md", "x", storeDir, onErrors);
		expect(await hasDoc("gone.md", storeDir)).toBe(true);

		const ok = await deleteDoc("gone.md", storeDir, onErrors);
		expect(ok).toBe(true);
		expect(await hasDoc("gone.md", storeDir)).toBe(false);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("deleteDoc on missing file returns false and reports an error", async () => {
		const ok = await deleteDoc("nothing.md", storeDir, onErrors);
		expect(ok).toBe(false);
		expect(onErrors).toHaveBeenCalledTimes(1);
		expect(onErrors.mock.calls[0]![0]).toMatchObject({ code: "ENOENT" });
	});

	it("listDocs returns every file under a prefix recursively", async () => {
		await putDoc("a/b/c.md", "c", storeDir, onErrors);
		await putDoc("a/b/d.md", "d", storeDir, onErrors);
		await putDoc("a/b/e/f.md", "f", storeDir, onErrors);
		await putDoc("a/b/e/f/g/h.md", "h", storeDir, onErrors);
		await putDoc("other.md", "other", storeDir, onErrors);

		const got = await listDocs("a/b", storeDir, onErrors);
		const paths = got!.map((e) => e.path).sort();
		expect(paths).toEqual([
			"a/b/c.md",
			"a/b/d.md",
			"a/b/e/f.md",
			"a/b/e/f/g/h.md",
		]);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("listDocs entries include size and mtime", async () => {
		await putDoc("m/file.md", "twelve bytes", storeDir, onErrors);
		const got = await listDocs("m", storeDir, onErrors);
		expect(got).toHaveLength(1);
		expect(got![0]!.size).toBe(Buffer.byteLength("twelve bytes", "utf8"));
		expect(typeof got![0]!.mtime).toBe("number");
		expect(got![0]!.mtime).toBeGreaterThan(0);
	});

	it("listDocs on empty dir name walks the whole store", async () => {
		await putDoc("x.md", "x", storeDir, onErrors);
		await putDoc("y/z.md", "z", storeDir, onErrors);
		const got = await listDocs("", storeDir, onErrors);
		const paths = got!.map((e) => e.path).sort();
		expect(paths).toEqual(["x.md", "y/z.md"]);
	});

	it("listDocs on missing prefix returns empty list (no error)", async () => {
		const got = await listDocs("does/not/exist", storeDir, onErrors);
		expect(got).toEqual([]);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("rejects path traversal on every mutating op", async () => {
		const bad = [
			"../escape.md",
			"a/../../escape.md",
			"/absolute/path.md",
			"with\0null.md",
			"",
		];
		for (const p of bad) {
			expect(await putDoc(p, "x", storeDir, onErrors)).toBe(false);
			expect(await appendDoc(p, "x", storeDir, onErrors)).toBe(false);
			expect(await getDoc(p, storeDir, onErrors)).toBeNull();
			expect(await hasDoc(p, storeDir)).toBe(false);
			expect(await deleteDoc(p, storeDir, onErrors)).toBe(false);
		}
		// putDoc + appendDoc + getDoc + deleteDoc each report; hasDoc stays quiet.
		expect(onErrors).toHaveBeenCalledTimes(bad.length * 4);
		for (const call of onErrors.mock.calls) {
			expect(call[0]).toMatchObject({ code: "INVALID_PATH" });
		}
	});

	it("renameDoc moves a file atomically and auto-creates dest dirs", async () => {
		await putDoc("drafts/v1.md", "hello", storeDir, onErrors);
		const ok = await renameDoc(
			"drafts/v1.md",
			"archive/2026-04/v1.md",
			storeDir,
			onErrors
		);
		expect(ok).toBe(true);
		expect(await hasDoc("drafts/v1.md", storeDir)).toBe(false);
		expect(await getDoc("archive/2026-04/v1.md", storeDir, onErrors)).toBe(
			"hello"
		);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("renameDoc rejects invalid paths on either side", async () => {
		await putDoc("a.md", "x", storeDir, onErrors);
		expect(await renameDoc("../bad.md", "a.md", storeDir, onErrors)).toBe(
			false
		);
		expect(await renameDoc("a.md", "../bad.md", storeDir, onErrors)).toBe(
			false
		);
		expect(onErrors).toHaveBeenCalledTimes(2);
	});

	it("renameDoc on missing source returns false and reports", async () => {
		const ok = await renameDoc("nope.md", "there.md", storeDir, onErrors);
		expect(ok).toBe(false);
		expect(onErrors).toHaveBeenCalledTimes(1);
	});

	it("getDocLines returns an inclusive 1-indexed range", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
		await putDoc("log.md", lines.join("\n") + "\n", storeDir, onErrors);

		expect(await getDocLines("log.md", 1, 3, storeDir, onErrors)).toBe(
			"line-1\nline-2\nline-3"
		);
		expect(await getDocLines("log.md", 5, 5, storeDir, onErrors)).toBe(
			"line-5"
		);
		// Out-of-range to clamps to end
		expect(await getDocLines("log.md", 9, 100, storeDir, onErrors)).toBe(
			"line-9\nline-10"
		);
		// from > to returns empty
		expect(await getDocLines("log.md", 5, 3, storeDir, onErrors)).toBe("");
		// from past EOF returns empty
		expect(await getDocLines("log.md", 50, 60, storeDir, onErrors)).toBe("");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("getDocLines rejects invalid paths and missing files", async () => {
		expect(await getDocLines("../x.md", 1, 5, storeDir, onErrors)).toBeNull();
		expect(
			await getDocLines("missing.md", 1, 5, storeDir, onErrors)
		).toBeNull();
		expect(onErrors).toHaveBeenCalledTimes(2);
	});

	it("parseFrontmatter extracts scalar and list fields", async () => {
		const src =
			"---\nsummary: current v2 plan\ntags: [planner, urgent]\nauthor: \"urim\"\n---\n# Body\nhello\n";
		const { meta, body } = parseFrontmatter(src);
		expect(meta.summary).toBe("current v2 plan");
		expect(meta.tags).toEqual(["planner", "urgent"]);
		expect(meta.author).toBe("urim");
		expect(body).toBe("# Body\nhello\n");
	});

	it("parseFrontmatter returns empty meta for docs without a block", async () => {
		expect(parseFrontmatter("# just body\n").meta).toEqual({});
		expect(parseFrontmatter("---\nno-close: true").meta).toEqual({});
		expect(parseFrontmatter("").meta).toEqual({});
	});

	it("parseFrontmatter handles CRLF line endings", async () => {
		const crlf =
			"---\r\nsummary: windows note\r\ntags: [a, b]\r\n---\r\n# body\r\nhello\r\n";
		const { meta, body } = parseFrontmatter(crlf);
		expect(meta.summary).toBe("windows note");
		expect(meta.tags).toEqual(["a", "b"]);
		expect(body).toBe("# body\r\nhello\r\n");
	});

	it("renderIndex summary read is bounded even for huge files", async () => {
		const huge =
			"---\nsummary: fits in head\n---\n" + "x".repeat(200_000);
		await putDoc("big/doc.md", huge, storeDir, onErrors);
		const out = await renderIndex("big", storeDir, onErrors);
		expect(out).toContain("fits in head");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("grepDocs finds substring matches with stable path-then-line ordering", async () => {
		await putDoc(
			"conversations/urim/2026-04-01.md",
			"the player mentioned his sister\nand then moved on\n",
			storeDir,
			onErrors
		);
		await putDoc(
			"conversations/urim/2026-04-05.md",
			"again the sister came up\n",
			storeDir,
			onErrors
		);
		await putDoc(
			"conversations/urim/2026-04-10.md",
			"third time: sister's startup\n",
			storeDir,
			onErrors
		);
		await putDoc("other.md", "no match here", storeDir, onErrors);

		const hits = await grepDocs(
			"sister",
			"conversations",
			storeDir,
			onErrors
		);
		expect(hits!.map((h) => h.path)).toEqual([
			"conversations/urim/2026-04-01.md",
			"conversations/urim/2026-04-05.md",
			"conversations/urim/2026-04-10.md",
		]);
		expect(hits![0]!.line).toBe(1);
		expect(hits![0]!.text).toContain("sister");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("grepDocs respects caseInsensitive and maxResults", async () => {
		await putDoc("a.md", "Apple\napple\nAPPLE\n", storeDir, onErrors);
		const sensitive = await grepDocs("apple", "", storeDir, onErrors);
		expect(sensitive).toHaveLength(1);

		const insensitive = await grepDocs("apple", "", storeDir, onErrors, {
			caseInsensitive: true,
		});
		expect(insensitive).toHaveLength(3);

		const capped = await grepDocs("apple", "", storeDir, onErrors, {
			caseInsensitive: true,
			maxResults: 2,
		});
		expect(capped).toHaveLength(2);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("grepDocs supports regex mode", async () => {
		await putDoc(
			"note.md",
			"task-42 open\ntask-43 done\nnothing-here\n",
			storeDir,
			onErrors
		);
		const hits = await grepDocs("^task-\\d+", "", storeDir, onErrors, {
			regex: true,
		});
		expect(hits).toHaveLength(2);
		expect(hits!.map((h) => h.line)).toEqual([1, 2]);
	});

	it("grepDocs rejects empty pattern and invalid regex", async () => {
		expect(await grepDocs("", "", storeDir, onErrors)).toBeNull();
		expect(
			await grepDocs("[unclosed", "", storeDir, onErrors, { regex: true })
		).toBeNull();
		expect(onErrors).toHaveBeenCalledTimes(2);
		for (const call of onErrors.mock.calls) {
			expect(call[0]).toMatchObject({ code: "INVALID_PATTERN" });
		}
	});

	it("renderIndex produces a markdown table of non-recursive files", async () => {
		await putDoc("players/charles/vision.md", "v", storeDir, onErrors);
		await putDoc("players/charles/top-task.md", "t", storeDir, onErrors);
		await putDoc(
			"players/charles/conversations/urim/x.md",
			"y",
			storeDir,
			onErrors
		);

		const out = await renderIndex(
			"players/charles",
			storeDir,
			onErrors
		);
		expect(out).toContain("# Index: players/charles");
		expect(out).toContain("players/charles/vision.md");
		expect(out).toContain("players/charles/top-task.md");
		// Non-recursive: files in deeper dirs are excluded
		expect(out).not.toContain("conversations/urim/x.md");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("renderIndex with recursive:true includes descendants", async () => {
		await putDoc("p/a.md", "a", storeDir, onErrors);
		await putDoc("p/sub/b.md", "b", storeDir, onErrors);
		await putDoc("p/sub/deep/c.md", "c", storeDir, onErrors);
		const out = await renderIndex("p", storeDir, onErrors, {
			recursive: true,
		});
		expect(out).toContain("p/a.md");
		expect(out).toContain("p/sub/b.md");
		expect(out).toContain("p/sub/deep/c.md");
	});

	it("renderIndex pulls summary from frontmatter", async () => {
		await putDoc(
			"m/memory.md",
			"---\nsummary: Current v2 goals\n---\n# body\n",
			storeDir,
			onErrors
		);
		await putDoc("m/plain.md", "no frontmatter", storeDir, onErrors);
		const out = await renderIndex("m", storeDir, onErrors);
		expect(out).toContain("Current v2 goals");
		// Plain file shows an empty summary cell, not an error
		expect(out).toContain("| m/plain.md |");
	});

	it("renderIndex excludes INDEX.md itself", async () => {
		await putDoc("d/x.md", "x", storeDir, onErrors);
		await putDoc("d/INDEX.md", "stale", storeDir, onErrors);
		const out = await renderIndex("d", storeDir, onErrors);
		expect(out).toContain("d/x.md");
		expect(out).not.toContain("d/INDEX.md");
	});

	it("writeIndex persists a fresh INDEX.md and replaces any stale one", async () => {
		await putDoc("mem/a.md", "a", storeDir, onErrors);
		await putDoc("mem/b.md", "b", storeDir, onErrors);
		const ok = await writeIndex("mem", storeDir, onErrors);
		expect(ok).toBe(true);

		const persisted = await getDoc("mem/INDEX.md", storeDir, onErrors);
		expect(persisted).toContain("# Index: mem");
		expect(persisted).toContain("mem/a.md");
		expect(persisted).toContain("mem/b.md");
		// Running again overwrites cleanly
		await putDoc("mem/c.md", "c", storeDir, onErrors);
		await writeIndex("mem", storeDir, onErrors);
		const refreshed = await getDoc("mem/INDEX.md", storeDir, onErrors);
		expect(refreshed).toContain("mem/c.md");
	});

	it("writeIndex at the root writes INDEX.md at the store root", async () => {
		await putDoc("top.md", "x", storeDir, onErrors);
		await writeIndex("", storeDir, onErrors);
		const persisted = await getDoc("INDEX.md", storeDir, onErrors);
		expect(persisted).toContain("# Index\n");
		expect(persisted).toContain("top.md");
	});

	it("putDoc then listDocs supports compaction flow: keep newest, delete rest", async () => {
		await putDoc("memory/001.md", "old", storeDir, onErrors);
		// nudge the mtime so ordering is deterministic
		await new Promise((r) => setTimeout(r, 5));
		await putDoc("memory/002.md", "newer", storeDir, onErrors);
		await new Promise((r) => setTimeout(r, 5));
		await putDoc("memory/003.md", "newest", storeDir, onErrors);

		const entries = await listDocs("memory", storeDir, onErrors);
		entries!.sort((a, b) => b.mtime - a.mtime);
		const [newest, ...older] = entries!;
		for (const e of older) {
			await deleteDoc(e.path, storeDir, onErrors);
		}
		const remaining = await listDocs("memory", storeDir, onErrors);
		expect(remaining!.map((e) => e.path)).toEqual([newest!.path]);
		expect(await getDoc(newest!.path, storeDir, onErrors)).toBe("newest");
	});
});
