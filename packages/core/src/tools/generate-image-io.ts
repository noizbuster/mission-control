import type { GenerateImageInput } from '@mission-control/protocol';
import { filePatchFailure } from './file-patch-errors';
import type { PatchTarget, PatchWorkspaceGuard } from './file-patch-paths';
import { decodeImageBase64 } from './generate-image-bytes';
import type { GeneratedImageBytes, GenerateImageToolOptions } from './generate-image-tool';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { extname, join } from 'node:path';

const MEDIA_ARTIFACTS_SUBDIR = 'artifacts/media';

export async function decodeInputImages(
    input: GenerateImageInput,
    options: GenerateImageToolOptions,
    guard: PatchWorkspaceGuard,
    toolCallId: string,
): Promise<readonly GeneratedImageBytes[]> {
    const entries = input.input ?? [];
    if (entries.length === 0) return [];
    const paths = entries.flatMap((entry) => (entry.path === undefined ? [] : [entry.path]));
    if (paths.length > 0) await requireImagePermission(options, toolCallId, 'read', paths, guard.root);
    const decoded: GeneratedImageBytes[] = [];
    for (const entry of entries) {
        if (entry.data !== undefined) {
            decoded.push({ bytes: decodeImageBase64(entry.data), mimeType: entry.mime_type ?? 'image/png' });
        }
        if (entry.path !== undefined) {
            const target = await guard.resolveTarget(entry.path, 'existing');
            const handle = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const bytes = await handle.readFile();
                decoded.push({
                    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                    mimeType: entry.mime_type ?? imageMimeType(target.absolutePath),
                });
            } finally {
                await handle.close();
            }
        }
    }
    return decoded;
}

export async function writeImagesToArtifacts(
    images: readonly GeneratedImageBytes[],
    artifactsDir: string,
): Promise<string[]> {
    await mkdir(artifactsDir, { recursive: true });
    const paths: string[] = [];
    for (const image of images) {
        const filepath = join(artifactsDir, `mctrl-image-${randomUUID()}.${extensionForMime(image.mimeType)}`);
        const handle = await open(
            filepath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o666,
        );
        try {
            await handle.writeFile(image.bytes);
        } finally {
            await handle.close();
        }
        paths.push(filepath);
    }
    return paths;
}

export function resolveArtifactsDir(input: GenerateImageInput, options: GenerateImageToolOptions): string {
    if (input.output_dir !== undefined) return input.output_dir;
    if (options.artifactsDir !== undefined) return options.artifactsDir;
    return join(options.workspaceRoot, MEDIA_ARTIFACTS_SUBDIR);
}

export function requireSingleTarget(targets: readonly PatchTarget[]): PatchTarget {
    const target = targets[0];
    if (target === undefined) throw filePatchFailure('write_failed', 'missing generate_image output boundary');
    return target;
}

export async function requireImagePermission(
    options: GenerateImageToolOptions,
    toolCallId: string,
    permission: 'read' | 'network',
    patterns: readonly string[],
    workspaceRoot: string,
): Promise<void> {
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId: `${toolCallId}.${permission}`,
            action: 'generate_image',
            reason: permission === 'read' ? 'read reference images from the workspace' : 'call the image provider',
            permission,
            patterns,
            workspaceRoot,
        }),
    );
    if (decision.status === 'allow') return;
    throw filePatchFailure(
        decision.status === 'deny' ? 'approval_denied' : 'approval_required',
        decision.reason ?? `generate_image ${permission} access not approved: ${decision.status}`,
    );
}

function extensionForMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        default:
            return 'png';
    }
}

function imageMimeType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        default:
            return 'image/png';
    }
}
