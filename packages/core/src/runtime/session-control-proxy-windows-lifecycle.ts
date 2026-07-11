import { SessionControlOwnerError } from './session-control-owner-error.js';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

const PROXY_READY_TIMEOUT_MS = 2_000;
const PROXY_CLOSE_TIMEOUT_MS = 2_000;

export function waitForWindowsProxyExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new SessionControlOwnerError('owner_unreachable', 'Windows owner proxy did not exit'));
        }, PROXY_CLOSE_TIMEOUT_MS);
        timeout.unref();
        const cleanup = (): void => {
            clearTimeout(timeout);
            child.removeListener('exit', onExit);
            child.removeListener('error', onError);
        };
        const onExit = (): void => {
            cleanup();
            resolve();
        };
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        child.once('exit', onExit);
        child.once('error', onError);
        if (child.exitCode !== null || child.signalCode !== null) onExit();
    });
}

export function readWindowsProxyReady(child: ChildProcess, stdout: Readable, stdin: Writable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const timeout = setTimeout(
            () => finishError('Windows owner proxy did not become ready'),
            PROXY_READY_TIMEOUT_MS,
        );
        timeout.unref();
        const cleanup = (): void => {
            clearTimeout(timeout);
            stdout.removeListener('data', onData);
            stdout.removeListener('error', onError);
            stdin.removeListener('error', onError);
            child.removeListener('error', onError);
            child.removeListener('exit', onExit);
            stdout.removeListener('end', onEnd);
        };
        const finishError = (message: string, cause?: Error): void => {
            cleanup();
            reject(new SessionControlOwnerError('owner_unreachable', message, cause));
        };
        const onError = (error: Error): void => finishError('Windows owner proxy failed', error);
        const onExit = (): void => finishError('Windows owner proxy exited before ready');
        const onEnd = (): void => finishError('Windows owner proxy closed output before ready');
        const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) return;
            cleanup();
            if (buffered.subarray(0, newline).toString('utf8') !== '{"type":"ready"}') {
                finishError('Windows owner proxy rejected bootstrap');
                return;
            }
            stdout.pause();
            resolve(buffered.subarray(newline + 1));
        };
        stdout.on('data', onData);
        stdout.once('error', onError);
        stdin.once('error', onError);
        child.once('error', onError);
        child.once('exit', onExit);
        stdout.once('end', onEnd);
    });
}
