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

interface DocEntry {
    path: string;
    size: number;
    mtime: number;
}
declare function putDoc(relPath: string, content: string, storeDir: string, onErrors: CondorErrHandler): Promise<boolean>;
declare function appendDoc(relPath: string, content: string, storeDir: string, onErrors: CondorErrHandler): Promise<boolean>;
declare function getDoc(relPath: string, storeDir: string, onErrors: CondorErrHandler): Promise<string | null>;
declare function hasDoc(relPath: string, storeDir: string): Promise<boolean>;
declare function listDocs(relDir: string, storeDir: string, onErrors: CondorErrHandler): Promise<DocEntry[] | null>;
declare function deleteDoc(relPath: string, storeDir: string, onErrors: CondorErrHandler): Promise<boolean>;
declare function renameDoc(fromPath: string, toPath: string, storeDir: string, onErrors: CondorErrHandler): Promise<boolean>;
declare function getDocLines(relPath: string, from: number, to: number, storeDir: string, onErrors: CondorErrHandler): Promise<string | null>;
interface Frontmatter {
    [key: string]: string | string[];
}
declare function parseFrontmatter(content: string): {
    meta: Frontmatter;
    body: string;
};
interface DocMatch {
    path: string;
    line: number;
    text: string;
}
interface GrepOpts {
    regex?: boolean;
    caseInsensitive?: boolean;
    maxResults?: number;
}
declare function grepDocs(pattern: string, relDir: string, storeDir: string, onErrors: CondorErrHandler, opts?: GrepOpts): Promise<DocMatch[] | null>;
interface IndexOpts {
    recursive?: boolean;
}
declare function renderIndex(relDir: string, storeDir: string, onErrors: CondorErrHandler, opts?: IndexOpts): Promise<string | null>;
declare function writeIndex(relDir: string, storeDir: string, onErrors: CondorErrHandler, opts?: IndexOpts): Promise<boolean>;

export { type CondorErr, type CondorErrHandler, CondorErrSchema, type CondorRec, CondorRecSchema, type DocEntry, type DocMatch, type Frontmatter, type GrepOpts, type IndexOpts, appendDoc, clearCache, create, deleteDoc, dumpMetrics, getBlob, getDoc, getDocLines, getMetrics, grepDocs, hasBlob, hasDoc, listDocs, load, load_, parseFrontmatter, putBlob, putDoc, renameDoc, renderIndex, save, writeIndex };
