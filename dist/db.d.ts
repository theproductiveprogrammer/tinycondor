import { z } from "zod";
export declare const CondorRecSchema: z.ZodObject<{
    id: z.ZodString;
    tm: z.ZodNumber;
}, "strip", z.ZodAny, z.objectOutputType<{
    id: z.ZodString;
    tm: z.ZodNumber;
}, z.ZodAny, "strip">, z.objectInputType<{
    id: z.ZodString;
    tm: z.ZodNumber;
}, z.ZodAny, "strip">>;
export type CondorRec = z.infer<typeof CondorRecSchema>;
export declare const CondorErrSchema: z.ZodObject<{
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
export type CondorErr = z.infer<typeof CondorErrSchema>;
export type CondorErrHandler = (err: CondorErr) => void;
export declare function clearCache(): void;
export declare function create(initialRecords: CondorRec[], dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;
export declare function load(dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;
export declare function load_(dbfile: string, onErrors: CondorErrHandler): Promise<Map<string, CondorRec> | null>;
export declare function save(recordArray: CondorRec[], dbfile: string, onErrors: CondorErrHandler): Promise<CondorRec[] | null>;
