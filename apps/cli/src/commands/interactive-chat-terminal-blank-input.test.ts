import { describe, expect, it } from 'vitest';
import { createTerminalChatInputFromStreams } from './interactive-chat-io.js';
import { EventEmitter } from 'node:events';

class FakeTerminalInput extends EventEmitter {
    isRaw = false;
    isPaused = true;

    setRawMode(isRaw: boolean): void {
        this.isRaw = isRaw;
    }

    resume(): void {
        this.isPaused = false;
    }

    pause(): void {
        this.isPaused = true;
    }

    send(chunk: Buffer | string): void {
        this.emit('data', chunk);
    }
}

class FakeTerminalOutput {
    private readonly chunks: string[] = [];

    write(text: string): void {
        this.chunks.push(text);
    }

    getOutput(): string {
        return this.chunks.join('');
    }
}

describe('terminal chat blank input handling', () => {
    it('keeps an empty Enter press pending without committing a blank prompt line', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();
        const beforeEnterOutput = output.getOutput();

        input.send('\r');

        await expect(readWithTimeout(read)).resolves.toEqual({ type: 'timeout' });
        expect(output.getOutput()).toBe(beforeEnterOutput);

        input.send('hello\r');

        await expect(read).resolves.toEqual({ type: 'line', value: 'hello' });
        chatInput.close();
    });

    it('keeps a whitespace-only Enter press pending without committing a blank prompt line', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('   ');
        const beforeEnterOutput = output.getOutput();
        input.send('\r');

        await expect(readWithTimeout(read)).resolves.toEqual({ type: 'timeout' });
        expect(output.getOutput()).toBe(beforeEnterOutput);

        input.send('hello\r');

        await expect(read).resolves.toEqual({ type: 'line', value: '   hello' });
        chatInput.close();
    });
});

function readWithTimeout(read: Promise<unknown>): Promise<unknown> {
    return Promise.race([
        read,
        new Promise((resolve) => {
            setTimeout(() => {
                resolve({ type: 'timeout' });
            }, 50);
        }),
    ]);
}
