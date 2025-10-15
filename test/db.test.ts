import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import mockFs from "mock-fs";

import { clearCache, create, load, save } from "../src/db";

const dbFile = "testdb.json";
const testRecords = [
	{ id: "1", tm: 100, val: 1 },
	{ id: "2", tm: 200, val: 1 },
];
const updatedRecords = [
	{ id: "1", tm: 300, val: 2 },
	{ id: "2", tm: 400, val: 2 },
];
const updatedRecords2 = [
	{ id: "2", tm: 300, val: 3 },
	{ id: "3", tm: 400, val: 3 },
];
const result2 = [
	{ id: "1", tm: 300, val: 2 },
	{ id: "2", tm: 400, val: 2 },
	{ id: "3", tm: 400, val: 3 },
];
const updatedRecords3 = [{ id: "3", tm: 400, val: 3, lies: false }];
const result3 = [
	{ id: "1", tm: 300, val: 2 },
	{ id: "2", tm: 400, val: 2 },
	{ id: "3", tm: 400, val: 3, lies: false },
];
const updatedRecords4 = [
	{ id: "1", tm: 100, val: 2 },
	{ id: "2", tm: 200, val: 3 },
];
const result4 = [
	{ id: "1", tm: 100, val: 2 },
	{ id: "2", tm: 200, val: 3 },
];
const updatedRecords5 = [
	{ id: "1", tm: 100, val: 2 },
	{ id: "2", tm: 50, val: 2 },
];
const result5 = [
	{ id: "1", tm: 100, val: 2 },
	{ id: "2", tm: 200, val: 1 },
];
const testRecords2 = [
	{
		id: "lognfo:o2b59c9kxYoU",
		tm: 1752319560685,
		position: { y: 753.8713974720046, x: 263.87139747200456 },
	},
	{ id: "lognfo:o2b59c9kxYoU", tm: 1752319560685 },
	{
		id: "lognfo:o2b59c9kxYoU",
		tm: 1752319560685,
		position: { y: 631.9334063343542, x: 104.7831854212467 },
	},
	{ id: "lognfo:o2b59c9kxYoU", tm: 1752319560685 },
	{
		id: "lognfo:o2b59c9kxYoU",
		tm: 1752319560685,
		position: { y: 714.7031775224002, x: 66.19802288322497 },
	},
	{ id: "lognfo:o2b59c9kxYoU", tm: 1752319560685 },
	{
		id: "lognfo:o2b59c9kxYoU",
		tm: 1752319560685,
		position: { y: 379.2948502177296, x: 95.15466096389932 },
	},
	{ id: "lognfo:o2b59c9kxYoU", tm: 1752319560685 },
	{
		id: "lognfo:o2b59c9kxYoU",
		tm: 1752319560685,
		position: { y: 386.4375596356945, x: 81.58351474326221 },
	},
];
const result6 = [
	{
		id: "lognfo:o2b59c9kxYoU",
		tm: 1752319560685,
		position: { y: 386.4375596356945, x: 81.58351474326221 },
	},
];

describe("Tiny Condor", () => {
	let onErrors: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		clearCache();
		mockFs({});
		onErrors = vi.fn();
	});

	afterEach(() => {
		mockFs.restore();
	});

	it("creates a new DB file with records", async () => {
		const result = await create(testRecords, dbFile, onErrors);
		expect(result).toEqual(testRecords);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("fails to create if DB already exists", async () => {
		await fs.writeFile(dbFile, "created");
		const result = await create(testRecords, dbFile, onErrors);
		expect(result).toBeNull();
		expect(onErrors).toHaveBeenCalledWith(
			expect.objectContaining({ code: "EEXIST" })
		);
	});

	it("loads an existing DB file", async () => {
		await create(testRecords, dbFile, onErrors);
		clearCache();
		const result = await load(dbFile, onErrors);
		expect(result).toEqual(testRecords);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("returns null and calls onErrors if load fails", async () => {
		const result = await load("nonexistent.json", onErrors);
		expect(result).toBeNull();
		expect(onErrors).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.any(String) })
		);
	});

	it("saves records to an existing DB file", async () => {
		await create(testRecords, dbFile, onErrors);
		const result = await save(updatedRecords, dbFile, onErrors);
		expect(result).toEqual(updatedRecords);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("saves records multiple times to an existing DB file", async () => {
		await create(testRecords, dbFile, onErrors);
		await save(updatedRecords, dbFile, onErrors);
		const result = await save(updatedRecords2, dbFile, onErrors);
		expect(result).toEqual(result2);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("saves records multiple times to an existing DB file without cache", async () => {
		await create(testRecords, dbFile, onErrors);
		await save(updatedRecords, dbFile, onErrors);
		clearCache();
		const result = await save(updatedRecords2, dbFile, onErrors);
		expect(result).toEqual(result2);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("saves records to an existing DB file and reloads them properly", async () => {
		await create(testRecords, dbFile, onErrors);
		await save(updatedRecords, dbFile, onErrors);
		clearCache();
		await load(dbFile, onErrors);
		const result = await save(updatedRecords2, dbFile, onErrors);
		expect(onErrors).not.toHaveBeenCalled();
		expect(result).toEqual(result2);
	});

	it("returns null and calls onErrors if save fails (e.g., bad record)", async () => {
		await create(testRecords, dbFile, onErrors);
		const invalidRecord = [{ name: "Missing ID" }]; // no 'id' field
		await save(invalidRecord as any, dbFile, onErrors);
		expect(onErrors).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.any(String),
				record: invalidRecord[0],
			})
		);
	});

	it("saves boolean records", async () => {
		await create(testRecords, dbFile, onErrors);
		await save(updatedRecords, dbFile, onErrors);
		await save(updatedRecords2, dbFile, onErrors);
		const result = await save(updatedRecords3, dbFile, onErrors);
		expect(result).toEqual(result3);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("saves updated records with same timestamp", async () => {
		await create(testRecords, dbFile, onErrors);
		const result = await save(updatedRecords4, dbFile, onErrors);
		expect(result).toEqual(result4);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("does not update records with older timestamp", async () => {
		await create(testRecords, dbFile, onErrors);
		const result = await save(updatedRecords5, dbFile, onErrors);
		expect(result).toEqual(result5);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("updates records with same timestamp", async () => {
		await create(testRecords2, dbFile, onErrors);
		clearCache();
		const result = await load(dbFile, onErrors);
		expect(result).toEqual(result6);
		expect(onErrors).not.toHaveBeenCalled();
	});

	it("use cached records", async () => {
		await create(testRecords, dbFile, onErrors);
		await save(updatedRecords as any, dbFile, onErrors);
		const result = await save(updatedRecords2 as any, dbFile, onErrors);
		expect(result).toEqual(result2);
	});
});
