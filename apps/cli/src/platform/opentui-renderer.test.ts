import { describe, expect, it, vi } from 'vitest';
import {
    attachRendererResizeSync,
    hardResetRendererSurface,
    parseTmuxPaneSize,
    type RendererResizeTarget,
    readTerminalSize,
    readTmuxPaneSize,
    syncRendererToTerminalSize,
    type TerminalResizeSource,
} from './opentui-renderer.js';
import { EventEmitter } from 'node:events';

class FakeTerminalStream extends EventEmitter implements TerminalResizeSource {
    readonly columns?: number;
    readonly rows?: number;
    private windowSize: readonly [number, number] | undefined;

    constructor(columns: number | undefined, rows: number | undefined) {
        super();
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

class RecordingRenderer implements RendererResizeTarget {
    width: number;
    height: number;
    readonly calls: Array<readonly [number, number]> = [];
    renderRequests = 0;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    resize(width: number, height: number): void {
        this.calls.push([width, height]);
        this.width = width;
        this.height = height;
    }

    requestRender(): void {
        this.renderRequests += 1;
    }
}

class ResizeRenderProbeRenderer extends RecordingRenderer {
    readonly repaintStateDuringRender: boolean[] = [];

    override resize(width: number, height: number): void {
        super.resize(width, height);
        this.requestRender();
    }

    override requestRender(): void {
        this.repaintStateDuringRender.push(Reflect.get(this, 'forceFullRepaintRequested') === true);
        super.requestRender();
    }
}

class TerminalClearProbeRenderer extends RecordingRenderer {
    readonly events: string[] = [];
    readonly output: string[] = [];

    writeOut(chunk: string): boolean {
        this.events.push('clear');
        this.output.push(chunk);
        return true;
    }

    override resize(width: number, height: number): void {
        this.events.push('resize');
        super.resize(width, height);
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

class ResizeEventBufferProbeRenderer extends TerminalClearProbeRenderer {
    backgroundColor = 'default-bg';
    currentRenderBuffer: RecordingBuffer;
    nextRenderBuffer: RecordingBuffer;
    private readonly resizeListeners: Array<(width: number, height: number) => void> = [];

    constructor(width: number, height: number) {
        super(width, height);
        this.currentRenderBuffer = new RecordingBuffer(this.events, 'old-current');
        this.nextRenderBuffer = new RecordingBuffer(this.events, 'old-next');
    }

    override resize(width: number, height: number): void {
        super.resize(width, height);
        this.currentRenderBuffer = new RecordingBuffer(this.events, 'new-current');
        this.nextRenderBuffer = new RecordingBuffer(this.events, 'new-next');
        for (const listener of [...this.resizeListeners]) listener(this.width, this.height);
        this.requestRender();
    }

    override requestRender(): void {
        this.events.push('render');
        super.requestRender();
    }

    on(_event: 'resize', listener: (width: number, height: number) => void): void {
        this.resizeListeners.push(listener);
    }

    off(_event: 'resize', listener: (width: number, height: number) => void): void {
        const index = this.resizeListeners.indexOf(listener);
        if (index >= 0) this.resizeListeners.splice(index, 1);
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

    it('resizes the renderer when the terminal dimensions changed', () => {
        const stream = new FakeTerminalStream(80, 24);
        const renderer = new RecordingRenderer(80, 24);
        stream.setWindowSize(140, 40);

        expect(syncRendererToTerminalSize(renderer, stream)).toBe(true);
        expect(syncRendererToTerminalSize(renderer, stream)).toBe(false);

        expect(renderer.calls).toEqual([[140, 40]]);
        expect(renderer.renderRequests).toBe(1);
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
    });

    it('requests a full repaint before a resize-triggered render can run when the terminal shrinks', () => {
        const stream = new FakeTerminalStream(100, 30);
        const renderer = new ResizeRenderProbeRenderer(100, 30);
        stream.setWindowSize(60, 15);

        expect(syncRendererToTerminalSize(renderer, stream)).toBe(true);

        expect(renderer.calls).toEqual([[60, 15]]);
        expect(renderer.repaintStateDuringRender[0]).toBe(true);
    });

    it('clears the visible terminal surface before resizing to a smaller frame', () => {
        const stream = new FakeTerminalStream(100, 30);
        const renderer = new TerminalClearProbeRenderer(100, 30);
        stream.setWindowSize(60, 15);

        expect(syncRendererToTerminalSize(renderer, stream)).toBe(true);

        expect(renderer.events).toEqual(['clear', 'resize']);
        expect(renderer.output).toContain('\x1B[r\x1B[0m\x1B[H\x1B[2J\x1B[3J\x1B[H');
    });

    it('hard resets the visible terminal surface and retained renderer buffers', () => {
        const renderer = new ResizeEventBufferProbeRenderer(60, 15);

        hardResetRendererSurface(renderer);

        expect(renderer.events).toEqual(['clear', 'old-current:default-bg', 'old-next:default-bg', 'render']);
        expect(renderer.output).toContain('\x1B[r\x1B[0m\x1B[H\x1B[2J\x1B[3J\x1B[H');
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
    });

    it('clears swapped opentui render buffers when opentui emits its own shrink resize', () => {
        const stream = new FakeTerminalStream(100, 30);
        const renderer = new ResizeEventBufferProbeRenderer(100, 30);
        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 0 });
        renderer.events.length = 0;

        renderer.resize(60, 15);
        detach();

        expect(renderer.events).toEqual([
            'resize',
            'clear',
            'new-current:default-bg',
            'new-next:default-bg',
            'render',
            'render',
        ]);
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
    });

    it('dedupes duplicate resize events after the initial synchronization', () => {
        const stream = new FakeTerminalStream(100, 28);
        const renderer = new RecordingRenderer(80, 24);
        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 0 });

        stream.emit('resize');
        stream.emit('resize');
        detach();

        expect(renderer.calls).toEqual([[100, 28]]);
        expect(renderer.renderRequests).toBe(1);
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
    });

    it('subscribes to stream resize events and detaches cleanly', () => {
        const stream = new FakeTerminalStream(80, 24);
        const renderer = new RecordingRenderer(80, 24);
        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 0 });
        expect(stream.listenerCount('resize')).toBe(1);

        stream.setWindowSize(100, 28);
        stream.emit('resize');
        detach();
        expect(stream.listenerCount('resize')).toBe(0);
        stream.setWindowSize(120, 32);
        stream.emit('resize');

        expect(renderer.calls).toEqual([[100, 28]]);
    });

    it('cleans up the resize listener and polling interval idempotently', () => {
        vi.useFakeTimers();
        try {
            const stream = new FakeTerminalStream(80, 24);
            const renderer = new RecordingRenderer(80, 24);
            const offSpy = vi.spyOn(stream, 'off');
            const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 10 });

            expect(stream.listenerCount('resize')).toBe(1);
            expect(vi.getTimerCount()).toBe(1);

            detach();
            detach();

            expect(offSpy).toHaveBeenCalledTimes(1);
            expect(stream.listenerCount('resize')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('polls terminal size when resize events are not emitted and stops polling after detach', () => {
        vi.useFakeTimers();
        try {
            const stream = new FakeTerminalStream(80, 24);
            const renderer = new RecordingRenderer(80, 24);
            const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 10 });

            stream.setWindowSize(140, 40);
            vi.advanceTimersByTime(10);
            detach();
            stream.setWindowSize(160, 50);
            vi.advanceTimersByTime(10);

            expect(renderer.calls).toEqual([[140, 40]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('polls with the explicit size probe when the stream size is stale', () => {
        vi.useFakeTimers();
        try {
            const stream = new FakeTerminalStream(100, 28);
            const renderer = new RecordingRenderer(100, 28);
            let probedSize = { columns: 100, rows: 28 };
            const detach = attachRendererResizeSync(renderer, stream, {
                pollIntervalMs: 10,
                sizeProbe: () => probedSize,
            });

            probedSize = { columns: 140, rows: 40 };
            vi.advanceTimersByTime(10);
            probedSize = { columns: 140, rows: 40 };
            vi.advanceTimersByTime(10);
            detach();

            expect(renderer.calls).toEqual([[140, 40]]);
        } finally {
            vi.useRealTimers();
        }
    });
});
