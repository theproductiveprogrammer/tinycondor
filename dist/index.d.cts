import { z } from 'zod';

interface FileMetrics {
    dbfile: string;
    loadCount: number;
    saveCount: number;
    totalLoadTimeMs: number;
    totalSaveTimeMs: number;
    avgLoadTimeMs: number;
    avgSaveTimeMs: number;
    cacheHits: number;
    cacheMisses: number;
    recordsLoaded: number;
    recordsSaved: number;
    recordsRejected: number;
    errorCount: number;
    lastErrorTime?: number;
    lastOperationTime: number;
    currentFileSize: number;
    currentCacheSize: number;
}
declare const CondorRecSchema: z.ZodObject<{
    id: z.ZodString;
    tm: z.ZodNumber;
}, "strip", z.ZodAny, z.objectOutputType<{
    id: z.ZodString;
    tm: z.ZodNumber;
}, z.ZodAny, "strip">, z.objectInputType<{
    id: z.ZodString;
    tm: z.ZodNumber;
}, z.ZodAny, "strip">>;
type CondorRec = z.infer<typeof CondorRecSchema>;
declare const CondorErrSchema: z.ZodObject<{
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    record: z.ZodOptional<z.ZodAny>;
    err: z.ZodOptional<z.ZodAny>;
}, "strip", z.ZodTypeAny, {
    message: string;
    code?: string | undefined;
    record?: any;
    err?: any;
}, {
    message: string;
    code?: string | undefined;
    record?: any;
    err?: any;
}>;
type CondorErr = z.infer<typeof CondorErrSchema>;
type CondorErrHandler = (err: CondorErr) => void;
declare function clearCache(dbfile?: string): void;
declare function create(initialRecords: CondorRec[], dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;
declare function load(dbfile: string, onErrors: CondorErrHandler, maxFileSizeBytes?: number): Promise<CondorRec[] | null>;
declare function load_(dbfile: string, onErrors: CondorErrHandler, maxFileSizeBytes?: number): Promise<Map<string, CondorRec> | null>;
declare function save(recordArray: CondorRec[], dbfile: string, onErrors: CondorErrHandler, maxFileSizeBytes?: number): Promise<CondorRec[] | null>;
declare function getMetrics(dbfile?: string): FileMetrics | Map<string, FileMetrics> | undefined;
declare function dumpMetrics(dbfile?: string, outputPath?: string): Promise<void>;

declare function putBlob(data: string | Buffer, storeDir: string, onErrors: CondorErrHandler): Promise<string | null>;
declare function getBlob(hash: string, storeDir: string, onErrors: CondorErrHandler): Promise<Buffer | null>;
declare function hasBlob(hash: string, storeDir: string): Promise<boolean>;

export { type CondorErr, type CondorErrHandler, CondorErrSchema, type CondorRec, CondorRecSchema, clearCache, create, dumpMetrics, getBlob, getMetrics, hasBlob, load, load_, putBlob, save };
