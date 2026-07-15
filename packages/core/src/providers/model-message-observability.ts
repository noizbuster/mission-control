import { type ModelMessage, modelMessageSchema } from 'ai';
import { OBSERVABILITY_TRUNCATED, type ObservabilityRedactor } from './observability-redactor';
import { createHash } from 'node:crypto';

export function redactModelMessagesForObservability(
    messages: readonly ModelMessage[],
    redactor: ObservabilityRedactor,
): readonly ModelMessage[] {
    const evalRedacted = messages.map((message) => {
        if (message.role !== 'assistant' || typeof message.content === 'string') {
            return message;
        }
        return {
            ...message,
            content: message.content.map((part) =>
                part.type === 'tool-call' ? { ...part, input: observableToolInput(part.toolName, part.input) } : part,
            ),
        };
    });
    const parsed = modelMessageSchema.array().safeParse(redactor.redactValue(evalRedacted));
    return parsed.success ? parsed.data : [{ role: 'assistant', content: OBSERVABILITY_TRUNCATED }];
}

export function observableToolInput(toolName: string, input: unknown): unknown {
    if (toolName !== 'eval') {
        return input;
    }
    const serialized = typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
    return {
        redacted: true,
        sha256: createHash('sha256').update(serialized).digest('hex'),
    };
}
