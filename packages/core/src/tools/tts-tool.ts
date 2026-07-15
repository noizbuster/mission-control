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
    type TtsInput,
    type TtsOutput,
    ttsInputSchema,
    ttsOutputSchema,
} from '@mission-control/protocol';
import type { z } from 'zod';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const XAI_DEFAULT_VOICE = 'eve';
const XAI_DEFAULT_LANGUAGE = 'en';
const XAI_DEFAULT_SAMPLE_RATE = 24_000;
const XAI_DEFAULT_BIT_RATE = 128_000;

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
    readonly credentialResolver?: TtsCredentialResolver;
    readonly transport?: TtsTransport;
};

const ttsInputSchemaType = ttsInputSchema as z.ZodType<TtsInput>;
const ttsOutputSchemaType = ttsOutputSchema as z.ZodType<TtsOutput>;

/**
 * Default env-var-gated xAI credential resolver. Tests inject a custom resolver.
 */
export function createEnvTtsCredentialResolver(
    env: Readonly<Record<string, string | undefined>> = process.env,
): TtsCredentialResolver {
    return async () => {
        const apiKey = env['XAI_API_KEY'];
        if (apiKey === undefined || apiKey.length === 0) {
            return undefined;
        }
        const baseURL = env['XAI_BASE_URL'] ?? 'https://api.x.ai';
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
        execute: (input, context) => runTts(input, options, credentialResolver, context.signal),
        toModelOutput: ttsModelOutput,
        guideline: 'Use tts to synthesize speech. The output is a file path; audio bytes stay on disk.',
    };
}

async function runTts(
    input: TtsInput,
    options: TtsToolOptions,
    credentialResolver: TtsCredentialResolver,
    signal: AbortSignal,
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

    const transport = options.transport ?? defaultTtsTransport;
    const audio = await transport.synthesize(resolved, credential, signal).catch((error: unknown) => {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `tts failed: ${error instanceof Error ? error.message : String(error)}`,
            retryable: true,
        });
    });

    await mkdir(dirname(input.output_path), { recursive: true });
    await writeFile(input.output_path, audio.bytes);

    return {
        audio_path: input.output_path,
        bytes: audio.bytes.byteLength,
        voice_id: resolved.voiceId,
        codec: audio.codec,
        backend: 'xai',
    };
}

function inferCodec(outputPath: string): MediaTtsCodec {
    return outputPath.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
}

function ttsModelOutput(output: TtsOutput): string {
    return `tts: saved ${output.bytes} bytes to ${output.audio_path} (voice=${output.voice_id}, codec=${output.codec}, backend=${output.backend}).`;
}

export function noTtsCredentialMessage(): string {
    return 'No xAI TTS credential configured. Set XAI_API_KEY.';
}

export function ttsParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Text to synthesize (max 15000 characters).' },
            voice_id: {
                type: 'string',
                description: "xAI Grok Voice id (e.g. ara, eve, leo, rex, sal). Defaults to 'eve'.",
            },
            language: { type: 'string', description: "BCP-47 language tag. Defaults to 'en'." },
            output_path: {
                type: 'string',
                description: 'Path where the audio file is written (.wav or .mp3).',
            },
            sample_rate: { type: 'integer', description: 'Sample rate in Hz (default 24000).' },
            bit_rate: { type: 'integer', description: 'MP3 bit rate (default 128000).' },
        },
        required: ['text', 'voice_id', 'language', 'output_path'],
        additionalProperties: false,
    };
}

export const TTS_DEFAULT_VOICE = XAI_DEFAULT_VOICE;
export const TTS_DEFAULT_LANGUAGE = XAI_DEFAULT_LANGUAGE;

/**
 * Default transport hits the live xAI Grok Voice endpoint. Tests inject a mock.
 */
const defaultTtsTransport: TtsTransport = {
    async synthesize(input, credential, signal) {
        const payload: Record<string, unknown> = {
            text: input.text,
            voice_id: input.voiceId,
            language: input.language,
        };
        const sampleRateOverridden = input.sampleRate !== XAI_DEFAULT_SAMPLE_RATE;
        const bitRateOverridden = input.codec === 'mp3' && input.bitRate !== XAI_DEFAULT_BIT_RATE;
        if (input.codec !== 'mp3' || sampleRateOverridden || bitRateOverridden) {
            const format: Record<string, unknown> = { codec: input.codec };
            if (input.sampleRate) format['sample_rate'] = input.sampleRate;
            if (input.codec === 'mp3' && input.bitRate) format['bit_rate'] = input.bitRate;
            payload['output_format'] = format;
        }
        const response = await fetch(`${credential.baseURL}/tts`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credential.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal,
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`xAI TTS failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, codec: input.codec };
    },
};
