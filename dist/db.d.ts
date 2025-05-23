import { z } from 'zod';

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
declare function clearCache(): void;
declare function create(initialRecords: CondorRec[], dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;
declare function load(dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;
declare function load_(dbfile: string, onErrors: CondorErrHandler): Promise<Map<string, CondorRec> | null>;
declare function save(recordArray: CondorRec[], dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;

export { type CondorErr, type CondorErrHandler, CondorErrSchema, type CondorRec, CondorRecSchema, clearCache, create, load, load_, save };
