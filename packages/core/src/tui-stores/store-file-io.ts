import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            return undefined;
        }
        throw error;
    }
}

export async function atomicWriteTextFile(filePath: string, contents: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    try {
        await writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx' });
        await rename(tempPath, filePath);
    } finally {
        await rm(tempPath, { force: true });
    }
}

export function jsonText(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function jsonlText<T>(entries: readonly T[]): string {
    return entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

export function parseJsonText(contents: string): unknown | undefined {
    try {
        const parsed: unknown = JSON.parse(contents);
        return parsed;
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}

export function parseJsonlRecords<T>(contents: string, schema: z.ZodType<T>): readonly T[] {
    const records: T[] = [];
    for (const line of contents.split(/\r?\n/u)) {
        if (line.trim().length === 0) {
            continue;
        }
        const parsed = parseJsonText(line);
        if (parsed === undefined) {
            continue;
        }
        const result = schema.safeParse(parsed);
        if (result.success) {
            records.push(result.data);
        }
    }
    return records;
}

function isNodeError(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}
