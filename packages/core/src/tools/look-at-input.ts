import { lookAtErrorMessage, lookAtFailure } from './look-at-errors';
import type { LookAtInput } from './look-at-schemas';
import { ToolExecutionError } from './tool-registry';
import type { VisionImage } from './vision-providers';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const EXTENSION_MIME_MAP: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.json': 'application/json',
};

export type PreparedVisionInput = {
    readonly images: readonly VisionImage[];
    readonly sourceDescription: string;
};

export type PrepareVisionResult =
    | { readonly ok: true; readonly value: PreparedVisionInput }
    | { readonly ok: false; readonly error: string };

export function inferMimeTypeFromFilePath(filePath: string): string {
    return EXTENSION_MIME_MAP[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function inferMimeTypeFromBase64(base64Data: string): string {
    if (base64Data.startsWith('data:')) {
        const match = /^data:([^;]+);/.exec(base64Data);
        if (match !== null && match[1] !== undefined) return match[1];
    }
    try {
        const cleanData = stripDataUriPrefix(base64Data);
        const header = Buffer.from(cleanData.slice(0, 256), 'base64').toString('binary');
        if (header.startsWith('\x89PNG')) return 'image/png';
        if (header.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
        if (header.startsWith('GIF8')) return 'image/gif';
        if (header.startsWith('RIFF') && header.includes('WEBP')) return 'image/webp';
        if (header.startsWith('%PDF')) return 'application/pdf';
    } catch {
        return 'image/png';
    }
    return 'image/png';
}

export function stripDataUriPrefix(imageData: string): string {
    if (!imageData.startsWith('data:')) return imageData;
    const commaIndex = imageData.indexOf(',');
    return commaIndex === -1 ? imageData : imageData.slice(commaIndex + 1);
}

export function prepareLookAtInput(input: LookAtInput, maxImageBytes: number): PrepareVisionResult {
    const filePaths = input.file_paths ?? (input.file_path !== undefined ? [input.file_path] : []);
    const imageDataList = input.image_data_list ?? (input.image_data !== undefined ? [input.image_data] : []);
    const totalInputs = filePaths.length + imageDataList.length;
    if (totalInputs === 0) {
        return {
            ok: false,
            error: "Must provide either 'file_path', 'file_paths', 'image_data', or 'image_data_list'.",
        };
    }
    for (const filePath of filePaths) {
        if (/^https?:\/\//i.test(filePath)) {
            return {
                ok: false,
                error: `Remote URLs are not supported for file paths. Download the file first or use a local path: ${filePath}`,
            };
        }
    }
    const images: VisionImage[] = [];
    for (const filePath of filePaths) {
        const result = captureVisionInput(() => readFileAsVisionImage(filePath, maxImageBytes));
        if (!result.ok) return result;
        images.push(result.value);
    }
    for (const [index, imageData] of imageDataList.entries()) {
        const result = captureVisionInput(() => readBase64AsVisionImage(imageData, maxImageBytes, index));
        if (!result.ok) return result;
        images.push(result.value);
    }
    const sourceDescription =
        totalInputs > 1
            ? `${totalInputs} files/images`
            : imageDataList.length === 1
              ? 'clipboard/pasted image'
              : (filePaths[0] ?? 'image');
    return { ok: true, value: { images, sourceDescription } };
}

function readFileAsVisionImage(filePath: string, maxImageBytes: number): VisionImage {
    try {
        statSync(filePath);
    } catch (error: unknown) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
        if (code === 'ENOENT') throw lookAtFailure(`File not found: ${filePath}`, false);
        throw lookAtFailure(`Failed to stat ${filePath}: ${lookAtErrorMessage(error)}`, false);
    }
    let bytes: Buffer;
    try {
        bytes = readFileSync(filePath);
    } catch (error: unknown) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
        if (code === 'ENOENT') throw lookAtFailure(`File not found: ${filePath}`, false);
        throw lookAtFailure(`Failed to read ${filePath}: ${lookAtErrorMessage(error)}`, false);
    }
    assertImageSize(bytes, maxImageBytes, filePath);
    return {
        mimeType: inferMimeTypeFromFilePath(filePath),
        base64Data: bytes.toString('base64'),
        filename: basename(filePath),
    };
}

function readBase64AsVisionImage(imageData: string, maxImageBytes: number, index: number): VisionImage {
    const cleanData = stripDataUriPrefix(imageData);
    const decoded = Buffer.from(cleanData, 'base64');
    assertImageSize(decoded, maxImageBytes, `image_data[${index}]`);
    const mimeType = inferMimeTypeFromBase64(imageData);
    const extension = mimeType.split('/')[1] ?? 'png';
    return { mimeType, base64Data: cleanData, filename: `clipboard-image-${index}.${extension}` };
}

function assertImageSize(bytes: Buffer, maxImageBytes: number, label: string): void {
    if (bytes.byteLength > maxImageBytes) {
        throw lookAtFailure(
            `${label} is ${bytes.byteLength} bytes which exceeds the ${maxImageBytes}-byte image-size cap. ` +
                'Downscale the image before sending.',
            false,
        );
    }
}

function captureVisionInput(
    read: () => VisionImage,
): { readonly ok: true; readonly value: VisionImage } | { readonly ok: false; readonly error: string } {
    try {
        return { ok: true, value: read() };
    } catch (error: unknown) {
        return {
            ok: false,
            error: error instanceof ToolExecutionError ? error.error.message : lookAtErrorMessage(error),
        };
    }
}
