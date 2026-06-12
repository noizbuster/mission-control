import { filePatchFailure } from './file-patch-errors.js';
import type { PatchTarget } from './file-patch-paths.js';
import { isBinarySample } from './read-tools-paths.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const binarySampleBytes = 4096;

export async function assertTextPatchTarget(target: PatchTarget): Promise<void> {
    if (!target.exists) {
        return;
    }
    const handle = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const sample = Buffer.alloc(binarySampleBytes);
        const result = await handle.read(sample, 0, sample.length, 0);
        if (isBinarySample(sample.subarray(0, result.bytesRead))) {
            throw filePatchFailure('binary_file', `binary target refused: ${target.relativePath}`);
        }
    } finally {
        await handle.close();
    }
}
