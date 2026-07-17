import { inspectErrorMessage, inspectFailure } from './inspect-image-errors';
import type { InspectImageInput } from './inspect-image-tool';
import {
    inferMimeTypeFromBase64,
    inferMimeTypeFromFilePath,
    stripDataUriPrefix,
    type VisionImage,
} from './look-at-tool';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const ACCEPTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function loadSingleImage(
    input: InspectImageInput,
    maxImageBytes: number,
): { readonly image: VisionImage; readonly source: string } {
    if (input.file_path !== undefined) {
        if (/^https?:\/\//i.test(input.file_path)) {
            throw inspectFailure(
                `Remote URLs are not supported. Download the file first or use a local path: ${input.file_path}`,
            );
        }
        try {
            statSync(input.file_path);
        } catch (error: unknown) {
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
            if (code === 'ENOENT') throw inspectFailure(`File not found: ${input.file_path}`);
            throw inspectFailure(`Failed to stat ${input.file_path}: ${inspectErrorMessage(error)}`);
        }
        let bytes: Buffer;
        try {
            bytes = readFileSync(input.file_path);
        } catch (error: unknown) {
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
            if (code === 'ENOENT') throw inspectFailure(`File not found: ${input.file_path}`);
            throw inspectFailure(`Failed to read ${input.file_path}: ${inspectErrorMessage(error)}`);
        }
        assertImageBytes(bytes, maxImageBytes, input.file_path);
        const mimeType = inferMimeTypeFromFilePath(input.file_path);
        if (!ACCEPTED_IMAGE_MIMES.has(mimeType)) {
            throw inspectFailure(
                `inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content (got ${mimeType}).`,
            );
        }
        return {
            image: { mimeType, base64Data: bytes.toString('base64'), filename: basename(input.file_path) },
            source: input.file_path,
        };
    }
    if (input.image_data !== undefined) {
        const cleanData = stripDataUriPrefix(input.image_data);
        const decoded = Buffer.from(cleanData, 'base64');
        assertImageBytes(decoded, maxImageBytes, 'image_data');
        const mimeType = inferMimeTypeFromBase64(input.image_data);
        if (!ACCEPTED_IMAGE_MIMES.has(mimeType)) {
            throw inspectFailure(`inspect_image only supports PNG, JPEG, GIF, and WEBP images (detected ${mimeType}).`);
        }
        const extension = mimeType.split('/')[1] ?? 'png';
        return {
            image: { mimeType, base64Data: cleanData, filename: `clipboard-image.${extension}` },
            source: 'clipboard/pasted image',
        };
    }
    throw inspectFailure("Must provide either 'file_path' or 'image_data'.");
}

function assertImageBytes(bytes: Buffer, maxImageBytes: number, label: string): void {
    if (bytes.byteLength > maxImageBytes) {
        throw inspectFailure(
            `${label} is ${bytes.byteLength} bytes which exceeds the ${maxImageBytes}-byte image-size cap. ` +
                'Downscale the image before sending.',
        );
    }
}
