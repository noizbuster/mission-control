import { describe, expect, it, vi } from 'vitest';
import {
    attachRendererResizeSync,
    hardResetRendererSurface,
    parseTmuxPaneSize,
    readTerminalSize,
    readTmuxPaneSize,
    syncRendererToTerminalSize,
    type TerminalResizeSource,
} from './opentui-renderer.js';

class FakeTerminalStream implements TerminalResizeSource {
    readonly columns?: number;
    readonly rows?: number;
    private windowSize: readonly [number, number] | undefined;

    constructor(columns: number | undefined, rows: number | undefined) {
        if (columns !== undefined) this.columns = columns;
        if (rows !== undefined) this.rows = rows;
    }

    setWindowSize(columns: number, rows: number): void {
        this.windowSize = [columns, rows];
    }

    getWindowSize(): readonly [number, number] {
        if (this.windowSize !== undefined) return this.windowSize;
        return [this.columns ?? 0, this.rows ?? 0];
    }
}

class RecordingBuffer {
    constructor(
        private readonly events: string[],
        private readonly name: string,
    ) {}

    clear(backgroundColor: unknown): void {
        this.events.push(`${this.name}:${String(backgroundColor)}`);
    }
}

class BufferProbeRenderer {
    backgroundColor = 'default-bg';
    currentRenderBuffer: RecordingBuffer;
    nextRenderBuffer: RecordingBuffer;
    readonly events: string[] = [];
    renderRequests = 0;

    constructor() {
        this.currentRenderBuffer = new RecordingBuffer(this.events, 'current');
        this.nextRenderBuffer = new RecordingBuffer(this.events, 'next');
    }

    requestRender(): void {
        this.events.push('render');
        this.renderRequests += 1;
    }
}

class FakeResizeStream implements TerminalResizeSource {
    columns: number;
    rows: number;
    private resizeListeners: Array<() => void> = [];

    constructor(columns: number, rows: number) {
        this.columns = columns;
        this.rows = rows;
    }

    getWindowSize(): readonly [number, number] {
        return [this.columns, this.rows];
    }

    on(_event: 'resize', listener: () => void): unknown {
        this.resizeListeners.push(listener);
        return listener;
    }

    off(_event: 'resize', listener: () => void): unknown {
        this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
        return undefined;
    }

    emitResize(): void {
        for (const listener of this.resizeListeners) listener();
    }
}

class ResizeProbeRenderer {
    width: number;
    height: number;
    resizeCalls: Array<{ width: number; height: number }> = [];
    renderRequests = 0;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    resize(width: number, height: number): void {
        this.resizeCalls.push({ width, height });
        this.width = width;
        this.height = height;
    }

    requestRender(): void {
        this.renderRequests += 1;
    }
}

describe('opentui renderer resize sync', () => {
    it('parses tmux pane size output defensively', () => {
        expect(parseTmuxPaneSize('140 40\n')).toEqual({ columns: 140, rows: 40 });
        expect(parseTmuxPaneSize('140')).toBeUndefined();
        expect(parseTmuxPaneSize('0 40')).toBeUndefined();
        expect(parseTmuxPaneSize('wide tall')).toBeUndefined();
    });

    it('reads tmux pane size when TMUX_PANE is available', () => {
        expect(readTmuxPaneSize({ TMUX_PANE: '%7' }, (paneId) => `${paneId === '%7' ? 140 : 80} 40`)).toEqual({
            columns: 140,
            rows: 40,
        });
        expect(readTmuxPaneSize({}, () => '140 40')).toBeUndefined();
        expect(readTmuxPaneSize({ TMUX_PANE: '%7' }, () => 'bad')).toBeUndefined();
    });

    it('prefers live TTY window size over stale columns and rows', () => {
        const stream = new FakeTerminalStream(80, 24);
        stream.setWindowSize(100, 28);

        expect(readTerminalSize(stream)).toEqual({ columns: 100, rows: 28 });
    });

    it('prefers an explicit terminal size probe over stale nested PTY size', () => {
        const stream = new FakeTerminalStream(100, 28);

        expect(readTerminalSize(stream, () => ({ columns: 140, rows: 40 }))).toEqual({ columns: 140, rows: 40 });
    });

    it('falls back to the stream size when a tmux probe is unavailable', () => {
        const stream = new FakeTerminalStream(80, 24);
        stream.setWindowSize(120, 30);

        expect(readTerminalSize(stream, () => undefined)).toEqual({ columns: 120, rows: 30 });
    });

    it('clears internal render buffers and requests a full repaint', () => {
        const renderer = new BufferProbeRenderer();

        hardResetRendererSurface(renderer);

        expect(renderer.events).toEqual(['current:default-bg', 'next:default-bg', 'render']);
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
        expect(renderer.renderRequests).toBe(1);
    });

    it('syncRendererToTerminalSize resizes when dimensions differ', () => {
        const stream = new FakeResizeStream(120, 36);
        const renderer = new ResizeProbeRenderer(80, 24);

        const resized = syncRendererToTerminalSize(renderer, stream);

        expect(resized).toBe(true);
        expect(renderer.resizeCalls).toEqual([{ width: 120, height: 36 }]);
        expect(renderer.width).toBe(120);
        expect(renderer.height).toBe(36);
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
        expect(renderer.renderRequests).toBe(1);
    });

    it('syncRendererToTerminalSize is a no-op when dimensions match', () => {
        const stream = new FakeResizeStream(80, 24);
        const renderer = new ResizeProbeRenderer(80, 24);

        const resized = syncRendererToTerminalSize(renderer, stream);

        expect(resized).toBe(false);
        expect(renderer.resizeCalls).toEqual([]);
        expect(renderer.renderRequests).toBe(0);
    });

    it('attachRendererResizeSync syncs immediately and on source resize events', () => {
        const stream = new FakeResizeStream(100, 30);
        const renderer = new ResizeProbeRenderer(80, 24);

        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 0 });

        expect(renderer.resizeCalls).toEqual([{ width: 100, height: 30 }]);

        stream.columns = 140;
        stream.rows = 40;
        stream.emitResize();

        expect(renderer.resizeCalls).toEqual([
            { width: 100, height: 30 },
            { width: 140, height: 40 },
        ]);

        detach();

        stream.columns = 200;
        stream.rows = 50;
        stream.emitResize();

        expect(renderer.resizeCalls).toHaveLength(2);
    });

    it('attachRendererResizeSync polls on an interval', () => {
        vi.useFakeTimers();
        const stream = new FakeResizeStream(80, 24);
        const renderer = new ResizeProbeRenderer(80, 24);

        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 250 });

        expect(renderer.resizeCalls).toEqual([]);

        stream.columns = 120;
        stream.rows = 36;
        vi.advanceTimersByTime(250);

        expect(renderer.resizeCalls).toEqual([{ width: 120, height: 36 }]);

        detach();
        vi.useRealTimers();
    });

    it('attachRendererResizeSync cleanup stops polling', () => {
        vi.useFakeTimers();
        const stream = new FakeResizeStream(80, 24);
        const renderer = new ResizeProbeRenderer(80, 24);

        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 250 });
        detach();

        stream.columns = 120;
        stream.rows = 36;
        vi.advanceTimersByTime(500);

        expect(renderer.resizeCalls).toEqual([]);
        vi.useRealTimers();
    });
});
