/**
 * `tts` tool registration (checkbox #33 — port-ref-tools).
 *
 * Credential-gated seam ported from oh-my-pi `tts.ts` (MIT) — xAI Grok Voice
 * path. The seam owns: schema surface (protocol), credential gating at
 * registration time, an injectable transport (so tests mock the provider), and
 * artifact-path output.
 *
 * Media is NEVER inlined: the transport returns raw audio bytes that this tool
 * writes to `output_path`; the serialized output carries the path only.
 */
import {
    type MediaTtsCodec,
    type PermissionDecision,
    type PermissionRequest,
    type TtsInput,
    type TtsOutput,
    ttsInputSchema,
    ttsOutputSchema,
} from '@mission-control/protocol';
import type { z } from 'zod';
import { executeFileMutation } from './file-mutation';
import { filePatchFailure } from './file-patch-errors';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import {
    type ToolAdvertisement,
    type ToolExecutionContext,
    ToolExecutionError,
    type ToolRegistration,
    ToolRegistry,
} from './tool-registry';
import { noTtsCredentialMessage, ttsModelOutput, ttsParametersJsonSchema } from './tts-presentation';
import {
    defaultTtsTransport,
    XAI_DEFAULT_BIT_RATE,
    XAI_DEFAULT_LANGUAGE,
    XAI_DEFAULT_SAMPLE_RATE,
    XAI_DEFAULT_VOICE,
} from './tts-transport';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export type GeneratedAudioBytes = {
    readonly bytes: Uint8Array;
    readonly codec: MediaTtsCodec;
};

export type TtsTransport = {
    readonly synthesize: (
        input: ResolvedTtsInput,
        credential: ResolvedTtsCredential,
        signal: AbortSignal,
    ) => Promise<GeneratedAudioBytes>;
};

export type ResolvedTtsCredential = {
    readonly apiKey: string;
    readonly baseURL: string;
};

export type TtsCredentialResolver = () => Promise<ResolvedTtsCredential | undefined>;

type TtsEnvironment = {
    readonly XAI_API_KEY?: string;
    readonly XAI_BASE_URL?: string;
    readonly [key: string]: string | undefined;
};

export type ResolvedTtsInput = {
    readonly text: string;
    readonly voiceId: string;
    readonly language: string;
    readonly codec: MediaTtsCodec;
    readonly sampleRate: number;
    readonly bitRate: number;
};

export type TtsToolOptions = {
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly credentialResolver?: TtsCredentialResolver;
    readonly transport?: TtsTransport;
};

const ttsInputSchemaType = ttsInputSchema as z.ZodType<TtsInput>;
const ttsOutputSchemaType = ttsOutputSchema as z.ZodType<TtsOutput>;

/**
 * Default env-var-gated xAI credential resolver. Tests inject a custom resolver.
 */
export function createEnvTtsCredentialResolver(env: TtsEnvironment = process.env): TtsCredentialResolver {
    return async () => {
        const apiKey = env.XAI_API_KEY;
        if (apiKey === undefined || apiKey.length === 0) {
            return undefined;
        }
        const baseURL = env.XAI_BASE_URL ?? 'https://api.x.ai';
        return { apiKey, baseURL };
    };
}

/**
 * Credential-gated registration. Returns `undefined` when no xAI credential is
 * configured, so the caller can skip registering the tool entirely.
 */
export async function registerTtsTool(
    registry: ToolRegistry,
    options: TtsToolOptions,
): Promise<ToolAdvertisement | undefined> {
    const resolver = options.credentialResolver ?? createEnvTtsCredentialResolver();
    const credential = await resolver();
    if (credential === undefined) {
        return undefined;
    }
    const registration = createTtsToolRegistration(options);
    return registry.register(registration);
}

export function createTtsToolRegistration(options: TtsToolOptions): ToolRegistration<TtsInput, TtsOutput> {
    const credentialResolver = options.credentialResolver ?? createEnvTtsCredentialResolver();
    const guard = createPatchWorkspaceGuard(options.workspaceRoot);
    return {
        name: 'tts',
        description:
            'Generate a speech audio file from text via xAI Grok Voice and write it to output_path. ' +
            'The tool returns the saved file path; audio bytes are never returned inline.',
        capabilityClasses: ['network', 'write'],
        parametersJsonSchema: ttsParametersJsonSchema(),
        inputSchema: ttsInputSchemaType,
        outputSchema: ttsOutputSchemaType,
        outputLimit: { maxModelOutputChars: 2_000 },
        execute: (input, context) => runTts(input, options, credentialResolver, guard, context),
        toModelOutput: ttsModelOutput,
        guideline: 'Use tts to synthesize speech. The output is a file path; audio bytes stay on disk.',
    };
}

async function runTts(
    input: TtsInput,
    options: TtsToolOptions,
    credentialResolver: TtsCredentialResolver,
    guardPromise: ReturnType<typeof createPatchWorkspaceGuard>,
    context: ToolExecutionContext,
): Promise<TtsOutput> {
    const credential = await credentialResolver();
    if (credential === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: noTtsCredentialMessage(),
            retryable: false,
        });
    }

    const codec = inferCodec(input.output_path);
    const resolved: ResolvedTtsInput = {
        text: input.text,
        voiceId: input.voice_id,
        language: input.language,
        codec,
        sampleRate: input.sample_rate ?? XAI_DEFAULT_SAMPLE_RATE,
        bitRate: input.bit_rate ?? XAI_DEFAULT_BIT_RATE,
    };

    const guard = await guardPromise;
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: guard.root,
            toolCallId: `${context.toolCallId}.write`,
            action: 'tts',
            reason: `write synthesized audio to ${input.output_path}`,
            permission: 'write',
            patterns: [input.output_path],
            requestPermission: options.requestPermission,
        },
        preflight: async () => [
            await guard.resolveTarget(input.output_path, 'either', { createParentDirectories: true }),
        ],
        apply: async (targets) => {
            const target = requireSingleTarget(targets);
            await requireTtsNetworkPermission(options, context.toolCallId, credential.baseURL, guard.root);
            const transport = options.transport ?? defaultTtsTransport;
            const audio = await transport.synthesize(resolved, credential, context.signal).catch((error: unknown) => {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: `tts failed: ${error instanceof Error ? error.message : String(error)}`,
                    retryable: true,
                });
            });
            await writeAudioTarget(target, audio.bytes);
            return {
                audio_path: target.absolutePath,
                bytes: audio.bytes.byteLength,
                voice_id: resolved.voiceId,
                codec: audio.codec,
                backend: 'xai',
            };
        },
    });
}

function requireSingleTarget(targets: readonly PatchTarget[]): PatchTarget {
    const target = targets[0];
    if (target === undefined) throw filePatchFailure('write_failed', 'missing tts output target');
    return target;
}

async function requireTtsNetworkPermission(
    options: TtsToolOptions,
    toolCallId: string,
    baseURL: string,
    workspaceRoot: string,
): Promise<void> {
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId: `${toolCallId}.network`,
            action: 'tts',
            reason: 'send text to the configured TTS provider',
            permission: 'network',
            patterns: [baseURL],
            workspaceRoot,
        }),
    );
    if (decision.status === 'allow') return;
    throw filePatchFailure(
        decision.status === 'deny' ? 'approval_denied' : 'approval_required',
        decision.reason ?? `tts network access not approved: ${decision.status}`,
    );
}

async function writeAudioTarget(target: PatchTarget, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(target.absolutePath), { recursive: true });
    const flags = target.exists
        ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const handle = await open(target.absolutePath, flags, 0o666);
    try {
        await handle.writeFile(bytes);
    } finally {
        await handle.close();
    }
}

function inferCodec(outputPath: string): MediaTtsCodec {
    return outputPath.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
}

export { noTtsCredentialMessage, ttsParametersJsonSchema } from './tts-presentation';

export const TTS_DEFAULT_VOICE = XAI_DEFAULT_VOICE;
export const TTS_DEFAULT_LANGUAGE = XAI_DEFAULT_LANGUAGE;
