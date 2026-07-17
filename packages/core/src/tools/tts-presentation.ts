import type { TtsInput, TtsOutput } from '@mission-control/protocol';

export function ttsModelOutput(output: TtsOutput): string {
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
            output_path: { type: 'string', description: 'Path where the audio file is written (.wav or .mp3).' },
            sample_rate: { type: 'integer', description: 'Sample rate in Hz (default 24000).' },
            bit_rate: { type: 'integer', description: 'MP3 bit rate (default 128000).' },
        } satisfies Record<keyof TtsInput, unknown>,
        required: ['text', 'voice_id', 'language', 'output_path'],
        additionalProperties: false,
    };
}
