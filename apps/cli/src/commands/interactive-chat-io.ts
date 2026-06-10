import { stdin as input, stdout as output } from 'node:process';

export type ChatInputEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
      };

export type ChatInput = {
    readonly read: () => Promise<ChatInputEvent>;
    readonly close: () => void;
};

export type ChatOutput = {
    readonly write: (text: string) => void;
    readonly getOutput?: () => string;
};

export const maxChatPromptLength = 8_000;

export function createTerminalChatOutput(): ChatOutput {
    return {
        write: (text: string) => {
            output.write(text);
        },
    };
}

export function createTerminalChatInput(): ChatInput {
    const wasRaw = input.isRaw === true;
    let closed = false;
    input.setRawMode(true);
    input.resume();

    return {
        read: async () => {
            if (closed) {
                return { type: 'interrupt' };
            }
            return readTerminalChatEvent();
        },
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            input.setRawMode(wasRaw);
            input.pause();
        },
    };
}

function readTerminalChatEvent(): Promise<ChatInputEvent> {
    return new Promise((resolve) => {
        const characters: string[] = [];

        function finish(event: ChatInputEvent): void {
            input.off('data', onData);
            resolve(event);
        }

        function onData(chunk: Buffer | string): void {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            if (text.startsWith('\u001b')) {
                return;
            }
            for (const character of text) {
                if (character === '\u0003') {
                    finish({
                        type: 'interrupt',
                        ...(characters.length > 0 ? { interruptedPartialInput: true } : {}),
                    });
                    return;
                }
                if (character === '\n' || character === '\r') {
                    output.write('\n');
                    finish({ type: 'line', value: characters.join('') });
                    return;
                }
                if (character === '\b' || character === '\u007f') {
                    if (characters.pop() !== undefined) {
                        output.write('\b \b');
                    }
                    continue;
                }
                if (characters.length >= maxChatPromptLength) {
                    output.write('\u0007');
                    continue;
                }
                characters.push(character);
                output.write(character);
            }
        }

        input.on('data', onData);
    });
}
