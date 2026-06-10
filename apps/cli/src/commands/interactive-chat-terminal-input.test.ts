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

describe('terminal chat input stream handling', () => {
    it('reads Korean input when one UTF-8 character is split across terminal chunks', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();
        const korean = Buffer.from('한', 'utf8');

        input.send(korean.subarray(0, 1));
        input.send(korean.subarray(1));
        input.send('\r');

        await expect(read).resolves.toEqual({ type: 'line', value: '한' });
        expect(output.getOutput()).toContain('> 한');
        chatInput.close();
    });

    it('buffers a split left-arrow escape before editing Korean text at the cursor', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('한글');
        input.send('\u001b');
        input.send('[D');
        input.send('!');
        input.send('\r');

        await expect(read).resolves.toEqual({ type: 'line', value: '한!글' });
        expect(output.getOutput()).not.toContain('[D');
        chatInput.close();
    });

    it('uses Home and End keys to edit at line boundaries', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('hello');
        input.send('\u001b[H');
        input.send('say ');
        input.send('\u001b[F');
        input.send('!');
        input.send('\r');

        await expect(read).resolves.toEqual({ type: 'line', value: 'say hello!' });
        chatInput.close();
    });

    it('uses PageUp and PageDown keys to edit at input boundaries', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('middle');
        input.send('\u001b[5~');
        input.send('start ');
        input.send('\u001b[6~');
        input.send(' end');
        input.send('\r');

        await expect(read).resolves.toEqual({ type: 'line', value: 'start middle end' });
        chatInput.close();
    });

    it('uses Ctrl+Left and Ctrl+Right keys to edit by word boundaries', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('alpha beta gamma');
        input.send('\u001b[1;5D');
        input.send('X');
        input.send('\u001b[1;5C');
        input.send('Y');
        input.send('\r');

        await expect(read).resolves.toEqual({ type: 'line', value: 'alpha beta XgammaY' });
        chatInput.close();
    });

    it('uses Ctrl+Up and Ctrl+Down keys to move to input boundaries', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('middle');
        input.send('\u001b[1;5A');
        input.send('start ');
        input.send('\u001b[1;5B');
        input.send(' end');
        input.send('\r');

        await expect(read).resolves.toEqual({ type: 'line', value: 'start middle end' });
        chatInput.close();
    });

    it('preserves Ctrl+C that arrives in the same terminal chunk after submitted input', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const firstRead = chatInput.read();

        input.send('first\r\u0003');

        await expect(firstRead).resolves.toEqual({ type: 'line', value: 'first' });
        await expect(chatInput.read()).resolves.toEqual({ type: 'interrupt' });
        chatInput.close();
    });

    it('coalesces duplicate Ctrl+C tokens that arrive in one terminal chunk', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const firstRead = chatInput.read();

        input.send('first\r\u0003\u001b[99;5u');

        await expect(firstRead).resolves.toEqual({ type: 'line', value: 'first' });
        await expect(chatInput.read()).resolves.toEqual({ type: 'interrupt' });
        await expect(readWithTimeout(chatInput.read())).resolves.toEqual({ type: 'timeout' });
        chatInput.close();
    });

    it('coalesces duplicate Ctrl+C tokens that arrive across adjacent terminal chunks', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const firstRead = chatInput.read();

        input.send('\u0003');

        await expect(firstRead).resolves.toEqual({ type: 'interrupt' });
        const duplicateRead = chatInput.read();
        input.send('\u001b[99;5u');

        await expect(readWithTimeout(duplicateRead)).resolves.toEqual({ type: 'timeout' });
        chatInput.close();
    });

    it('preserves a second Ctrl+C after the duplicate coalescing window', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const firstRead = chatInput.read();

        input.send('\u0003');

        await expect(firstRead).resolves.toEqual({ type: 'interrupt' });
        await delay(duplicateInterruptCoalescingWindowMs + 20);
        const secondRead = chatInput.read();
        input.send('\u0003');

        await expect(secondRead).resolves.toEqual({ type: 'interrupt' });
        chatInput.close();
    });

    it('preserves Ctrl+C from a separate event during delayed line submission', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const firstRead = chatInput.read();

        input.send('first\r');
        input.send('\u0003');

        await expect(firstRead).resolves.toEqual({ type: 'line', value: 'first' });
        await expect(chatInput.read()).resolves.toEqual({ type: 'interrupt' });
        chatInput.close();
    });

    it('reads Kitty CSI-u Ctrl+C as an interrupt', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('\u001b[99;5u');

        await expect(read).resolves.toEqual({ type: 'interrupt' });
        chatInput.close();
    });

    it('reads Kitty CSI-u Ctrl+C with a base layout key as an interrupt', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('\u001b[1089::99;5u');

        await expect(read).resolves.toEqual({ type: 'interrupt' });
        chatInput.close();
    });

    it('reads xterm modifyOtherKeys Ctrl+C as an interrupt', async () => {
        const input = new FakeTerminalInput();
        const output = new FakeTerminalOutput();
        const chatInput = createTerminalChatInputFromStreams({ input, output });
        const read = chatInput.read();

        input.send('\u001b[27;5;99~');

        await expect(read).resolves.toEqual({ type: 'interrupt' });
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

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

const duplicateInterruptCoalescingWindowMs = 120;
