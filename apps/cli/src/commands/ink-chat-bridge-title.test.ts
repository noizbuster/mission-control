import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTerminalTitle, setTerminalTitle } from './ink-chat-bridge.js';

const ENV_KEY = 'MCTRL_DISABLE_TERMINAL_TITLE';

function setTTY(value: boolean | undefined): void {
    Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
        writable: true,
    });
}

describe('setTerminalTitle', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;
    let originalTTY: boolean | undefined;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalTTY = process.stdout.isTTY;
        originalEnv = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        setTTY(true);
        writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        writeSpy.mockRestore();
        setTTY(originalTTY);
        if (originalEnv === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = originalEnv;
        }
    });

    it('writes the OSC 2 set escape with the title when stdout is a TTY', () => {
        setTerminalTitle('mission-control \u2014 my-session');

        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith('\x1b]2;mission-control \u2014 my-session\x07');
    });

    it('returns true when the escape is written', () => {
        const result = setTerminalTitle('test-title');

        expect(result).toBe(true);
    });

    it('does not write and returns false when MCTRL_DISABLE_TERMINAL_TITLE is 1', () => {
        process.env[ENV_KEY] = '1';

        const result = setTerminalTitle('test-title');

        expect(result).toBe(false);
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it('does not write and returns false when stdout is not a TTY', () => {
        setTTY(undefined);

        const result = setTerminalTitle('test-title');

        expect(result).toBe(false);
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it('does not write when isTTY is explicitly false', () => {
        setTTY(false);

        setTerminalTitle('test-title');

        expect(writeSpy).not.toHaveBeenCalled();
    });
});

describe('resetTerminalTitle', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;
    let originalTTY: boolean | undefined;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalTTY = process.stdout.isTTY;
        originalEnv = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        setTTY(true);
        writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        writeSpy.mockRestore();
        setTTY(originalTTY);
        if (originalEnv === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = originalEnv;
        }
    });

    it('writes the OSC 2 reset escape when stdout is a TTY', () => {
        resetTerminalTitle();

        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith('\x1b]2;\x07');
    });

    it('returns true when the escape is written', () => {
        const result = resetTerminalTitle();

        expect(result).toBe(true);
    });

    it('does not write and returns false when MCTRL_DISABLE_TERMINAL_TITLE is 1', () => {
        process.env[ENV_KEY] = '1';

        const result = resetTerminalTitle();

        expect(result).toBe(false);
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it('does not write and returns false when stdout is not a TTY', () => {
        setTTY(undefined);

        const result = resetTerminalTitle();

        expect(result).toBe(false);
        expect(writeSpy).not.toHaveBeenCalled();
    });
});

describe('terminal title lifecycle (bridge creation then unmount)', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;
    let originalTTY: boolean | undefined;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalTTY = process.stdout.isTTY;
        originalEnv = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        setTTY(true);
        writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        writeSpy.mockRestore();
        setTTY(originalTTY);
        if (originalEnv === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = originalEnv;
        }
    });

    it('sets the title on creation and resets on unmount when titleWasSet is true', () => {
        const titleWasSet = setTerminalTitle('mission-control \u2014 abc-123');
        expect(titleWasSet).toBe(true);
        expect(writeSpy).toHaveBeenCalledWith('\x1b]2;mission-control \u2014 abc-123\x07');

        writeSpy.mockClear();

        if (titleWasSet) {
            resetTerminalTitle();
        }
        expect(writeSpy).toHaveBeenCalledWith('\x1b]2;\x07');
    });

    it('skips reset on unmount when the title was never set (titleWasSet is false)', () => {
        process.env[ENV_KEY] = '1';
        const titleWasSet = setTerminalTitle('mission-control \u2014 abc-123');
        expect(titleWasSet).toBe(false);

        writeSpy.mockClear();

        if (titleWasSet) {
            resetTerminalTitle();
        }
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it('disables both set and reset when MCTRL_DISABLE_TERMINAL_TITLE is 1', () => {
        process.env[ENV_KEY] = '1';

        const titleWasSet = setTerminalTitle('anything');
        expect(titleWasSet).toBe(false);

        if (titleWasSet) {
            resetTerminalTitle();
        }

        expect(writeSpy).not.toHaveBeenCalled();
    });
});
