/**
 * `generate_image` tool registration (checkbox #33 — port-ref-tools).
 *
 * Credential-gated seam ported from oh-my-pi `image-gen.ts` (MIT). The seam
 * owns: schema surface (protocol), credential gating at registration time, an
 * injectable transport (so tests mock the provider), and artifact-dir output.
 *
 * Media is NEVER inlined: the transport returns raw bytes that this tool
 * writes to the artifacts dir; the serialized output carries paths only.
 */
import {
    type GenerateImageInput,
    type GenerateImageOutput,
    generateImageInputSchema,
    generateImageOutputSchema,
    MEDIA_IMAGE_PROVIDER_IDS,
    type MediaImageProviderId,
    type MediaImageProviderPreference,
    type PermissionDecision,
    type PermissionRequest,
} from '@mission-control/protocol';
import type { z } from 'zod';
import { executeFileMutation } from './file-mutation';
import { createPatchWorkspaceGuard } from './file-patch-paths';
import {
    decodeInputImages,
    requireImagePermission,
    requireSingleTarget,
    resolveArtifactsDir,
    writeImagesToArtifacts,
} from './generate-image-io';
import {
    generateImageModelOutput,
    generateImageParametersJsonSchema,
    noImageCredentialMessage,
} from './generate-image-presentation';
import { createEnvImageCredentialResolver, defaultImageTransport } from './generate-image-transport';
import {
    type ToolAdvertisement,
    type ToolExecutionContext,
    ToolExecutionError,
    type ToolRegistration,
    ToolRegistry,
} from './tool-registry';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export { generateImageParametersJsonSchema, noImageCredentialMessage } from './generate-image-presentation';
export { createEnvImageCredentialResolver } from './generate-image-transport';

export type GeneratedImageBytes = {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
};

export type GenerateImageTransportInput = {
    readonly prompt: string;
    readonly aspectRatio?: string;
    readonly imageSize?: string;
    /** Decoded input images for edits (already base64-decoded to bytes). */
    readonly inputImages: readonly GeneratedImageBytes[];
};

export type ResolvedImageCredential = {
    readonly provider: MediaImageProviderId;
    readonly apiKey: string;
    readonly model: string;
};

/**
 * Resolves an image-generation credential. Returns `undefined` when no provider
 * is configured, which the registration gate uses to skip the tool entirely.
 */
export type ImageCredentialResolver = () => Promise<ResolvedImageCredential | undefined>;

export type GenerateImageTransport = {
    readonly generate: (
        input: GenerateImageTransportInput,
        credential: ResolvedImageCredential,
        signal: AbortSignal,
    ) => Promise<readonly GeneratedImageBytes[]>;
};

export type GenerateImageToolOptions = {
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly artifactsDir?: string;
    readonly credentialResolver?: ImageCredentialResolver;
    readonly transport?: GenerateImageTransport;
};

const generateImageInputSchemaType = generateImageInputSchema as z.ZodType<GenerateImageInput>;
const generateImageOutputSchemaType = generateImageOutputSchema as z.ZodType<GenerateImageOutput>;

/**
 * Credential-gated registration. Returns `undefined` when no credential is
 * configured, so the caller can skip registering the tool entirely.
 */
export async function registerGenerateImageTool(
    registry: ToolRegistry,
    options: GenerateImageToolOptions,
): Promise<ToolAdvertisement | undefined> {
    const resolver = options.credentialResolver ?? createEnvImageCredentialResolver();
    const credential = await resolver();
    if (credential === undefined) {
        return undefined;
    }
    const registration = createGenerateImageToolRegistration(options);
    return registry.register(registration);
}

export function createGenerateImageToolRegistration(
    options: GenerateImageToolOptions,
): ToolRegistration<GenerateImageInput, GenerateImageOutput> {
    const credentialResolver = options.credentialResolver ?? createEnvImageCredentialResolver();
    const guard = createPatchWorkspaceGuard(options.workspaceRoot);
    return {
        name: 'generate_image',
        description:
            'Generate or edit raster images via Gemini, GPT, or xAI Grok image models. ' +
            'Generated images are saved to the media artifacts directory; the tool returns file paths only.',
        capabilityClasses: ['network', 'write'],
        parametersJsonSchema: generateImageParametersJsonSchema(),
        inputSchema: generateImageInputSchemaType,
        outputSchema: generateImageOutputSchemaType,
        outputLimit: { maxModelOutputChars: 4_000 },
        execute: (input, context) => runGenerateImage(input, options, credentialResolver, guard, context),
        toModelOutput: generateImageModelOutput,
        guideline:
            'Use generate_image to create or edit images. Output paths reference on-disk artifacts; ' +
            'image bytes are never returned inline.',
    };
}

async function runGenerateImage(
    input: GenerateImageInput,
    options: GenerateImageToolOptions,
    credentialResolver: ImageCredentialResolver,
    guardPromise: ReturnType<typeof createPatchWorkspaceGuard>,
    context: ToolExecutionContext,
): Promise<GenerateImageOutput> {
    const credential = await resolveCredentialForProvider(input.provider, credentialResolver);
    if (credential === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: noImageCredentialMessage(),
            retryable: false,
        });
    }

    const guard = await guardPromise;
    const requestedArtifactsDir = resolveArtifactsDir(input, options);
    const boundaryPath = join(requestedArtifactsDir, `.mctrl-media-boundary-${randomUUID()}`);
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: guard.root,
            toolCallId: `${context.toolCallId}.write`,
            action: 'generate_image',
            reason: `write generated images to ${requestedArtifactsDir}`,
            permission: 'write',
            patterns: [requestedArtifactsDir],
            requestPermission: options.requestPermission,
        },
        preflight: async () => [await guard.resolveTarget(boundaryPath, 'new', { createParentDirectories: true })],
        apply: async (targets) => {
            const boundary = requireSingleTarget(targets);
            const inputImages = await decodeInputImages(input, options, guard, context.toolCallId);
            await requireImagePermission(
                options,
                context.toolCallId,
                'network',
                [`provider:${credential.provider}`],
                guard.root,
            );
            const transport = options.transport ?? defaultImageTransport;
            const generated = await transport
                .generate(
                    {
                        prompt: input.prompt,
                        ...(input.aspect_ratio !== undefined ? { aspectRatio: input.aspect_ratio } : {}),
                        ...(input.image_size !== undefined ? { imageSize: input.image_size } : {}),
                        inputImages,
                    },
                    credential,
                    context.signal,
                )
                .catch((error: unknown) => {
                    throw new ToolExecutionError({
                        code: 'tool_failed',
                        message: `generate_image failed: ${error instanceof Error ? error.message : String(error)}`,
                        retryable: true,
                    });
                });
            if (generated.length === 0) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: 'generate_image returned no image data.',
                    retryable: true,
                });
            }
            const imagePaths = await writeImagesToArtifacts(generated, dirname(boundary.absolutePath));
            return {
                image_paths: imagePaths,
                provider: credential.provider,
                model: credential.model,
                count: imagePaths.length,
            };
        },
    });
}

async function resolveCredentialForProvider(
    preference: MediaImageProviderPreference | undefined,
    resolver: ImageCredentialResolver,
): Promise<ResolvedImageCredential | undefined> {
    const resolved = await resolver();
    if (resolved === undefined) {
        return undefined;
    }
    if (preference === undefined || preference === 'auto') {
        return resolved;
    }
    return resolved.provider === preference ? resolved : undefined;
}

export { MEDIA_IMAGE_PROVIDER_IDS };
