import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import mockFs from "mock-fs";

import { create, load, save } from "../src/db";

const dbFile = "testdb.json";
const testRecords = [
	{ id: "1", tm: 100, val: 1 },
	{ id: "2", tm: 200, val: 1 },
];
const updatedRecords = [
	{ id: "1", tm: 300, val: 2 },
	{ id: "2", tm: 400, val: 2 },
];

describe("Tiny Condor", () => {
	let onErrors: ReturnType<typeof vi.fn>;

	beforeEach(() => {
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
		await fs.writeFile(dbFile, "[]");
		const result = await create(testRecords, dbFile, onErrors);
		expect(result).toBeNull();
		expect(onErrors).toHaveBeenCalledWith(
			expect.objectContaining({ code: "EEXIST" })
		);
	});

	it("loads an existing DB file", async () => {
		await create(testRecords, dbFile, onErrors);
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
	});

	it("returns null and calls onErrors if save fails (e.g., bad record)", async () => {
		const invalidRecord = [{ name: "Missing ID" }]; // no 'id' field
		await save(invalidRecord as any, dbFile, onErrors);
		expect(onErrors).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.any(String),
				record: invalidRecord[0],
			})
		);
	});
});
