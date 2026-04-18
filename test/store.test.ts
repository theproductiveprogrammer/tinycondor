import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import mockFs from "mock-fs";

import { clearCache, load, save, create } from "../src/db";
import { putBlob, getBlob, hasBlob } from "../src/store";

const storeDir = "teststore";
const dbFile = "testdb.json";

// Known sha256 of the ascii string "hello".
const HELLO_SHA256 =
	"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("Blob store", () => {
	let onErrors: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		clearCache();
		mockFs({});
		onErrors = vi.fn();
	});

	afterEach(() => {
		mockFs.restore();
	});

	it("putBlob returns the sha256 hex of the content", async () => {
		const hash = await putBlob("hello", storeDir, onErrors);
		expect(hash).toBe(HELLO_SHA256);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("same content produces the same hash and is idempotent on disk", async () => {
		const h1 = await putBlob("same bytes", storeDir, onErrors);
		const fanout = h1!.slice(0, 2);
		const rest = h1!.slice(2);
		const path = `${storeDir}/${fanout}/${rest}`;
		const mtime1 = (await fs.stat(path)).mtimeMs;

		const h2 = await putBlob("same bytes", storeDir, onErrors);
		expect(h2).toBe(h1);
		const mtime2 = (await fs.stat(path)).mtimeMs;
		expect(mtime2).toBe(mtime1);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("different content produces different hashes", async () => {
		const h1 = await putBlob("alpha", storeDir, onErrors);
		const h2 = await putBlob("beta", storeDir, onErrors);
		expect(h1).not.toBe(h2);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("string input roundtrips as utf8", async () => {
		const hash = await putBlob("héllo 🌍", storeDir, onErrors);
		const got = await getBlob(hash!, storeDir, onErrors);
		expect(got!.toString("utf8")).toBe("héllo 🌍");
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("Buffer input roundtrips byte-exact", async () => {
		const bytes = Buffer.from([0x00, 0xff, 0x10, 0x20, 0xca, 0xfe]);
		const hash = await putBlob(bytes, storeDir, onErrors);
		const got = await getBlob(hash!, storeDir, onErrors);
		expect(Buffer.compare(got!, bytes)).toBe(0);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("getBlob on unknown hash returns null and reports an error", async () => {
		const missing =
			"0".repeat(64);
		const got = await getBlob(missing, storeDir, onErrors);
		expect(got).toBeNull();
		expect(onErrors).toHaveBeenCalledTimes(1);
	});

	it("hasBlob reflects presence", async () => {
		const hash = await putBlob("there", storeDir, onErrors);
		expect(await hasBlob(hash!, storeDir)).toBe(true);
		expect(await hasBlob("0".repeat(64), storeDir)).toBe(false);
	});

	it("getBlob rejects malformed hashes without touching the filesystem", async () => {
		const bad = [
			"../etc/passwd",
			"ABCDEF" + "0".repeat(58), // uppercase
			"0".repeat(63), // too short
			"0".repeat(65), // too long
			"zz" + "0".repeat(62), // non-hex
		];
		for (const h of bad) {
			const got = await getBlob(h, storeDir, onErrors);
			expect(got).toBeNull();
			expect(await hasBlob(h, storeDir)).toBe(false);
		}
		// Each getBlob call should have produced exactly one INVALID_HASH error.
		expect(onErrors).toHaveBeenCalledTimes(bad.length);
		for (const call of onErrors.mock.calls) {
			expect(call[0]).toMatchObject({ code: "INVALID_HASH" });
		}
	});

	it("integrates with db: reference a blob by hash in a record", async () => {
		const avatarBytes = Buffer.from("avatar-image-bytes");
		const hash = await putBlob(avatarBytes, storeDir, onErrors);
		expect(hash).not.toBeNull();

		await create(
			[{ id: "u1", tm: 1, avatar: hash } as any],
			dbFile,
			onErrors
		);

		clearCache();
		const loaded = await load(dbFile, onErrors);
		const rec = loaded!.find((r: any) => r.id === "u1") as any;
		expect(rec.avatar).toBe(hash);

		const got = await getBlob(rec.avatar, storeDir, onErrors);
		expect(Buffer.compare(got!, avatarBytes)).toBe(0);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("save a record pointing at a blob, then retrieve via the loaded hash", async () => {
		await create([{ id: "u1", tm: 1 }], dbFile, onErrors);
		const hash = await putBlob("payload-v2", storeDir, onErrors);
		await save(
			[{ id: "u1", tm: 2, attachment: hash } as any],
			dbFile,
			onErrors
		);
		clearCache();
		const loaded = await load(dbFile, onErrors);
		const rec = loaded!.find((r: any) => r.id === "u1") as any;
		const got = await getBlob(rec.attachment, storeDir, onErrors);
		expect(got!.toString("utf8")).toBe("payload-v2");
		expect(onErrors).not.toHaveBeenCalled();
	});
});
