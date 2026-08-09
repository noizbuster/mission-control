import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Temp-file-then-rename write (mirrors packages/core atomicWriteTextFile). */
export async function atomicTextWrite(filePath: string, contents: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    try {
        await writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx' });
        await rename(tempPath, filePath);
    } finally {
        await rm(tempPath, { force: true });
    }
}
