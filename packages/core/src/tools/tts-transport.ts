import type { TtsTransport } from './tts-tool';

export const XAI_DEFAULT_VOICE = 'eve';
export const XAI_DEFAULT_LANGUAGE = 'en';
export const XAI_DEFAULT_SAMPLE_RATE = 24_000;
export const XAI_DEFAULT_BIT_RATE = 128_000;

export const defaultTtsTransport: TtsTransport = {
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
