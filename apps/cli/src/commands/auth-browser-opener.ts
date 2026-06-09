import { spawn } from 'node:child_process';

export type BrowserOpener = (url: string) => Promise<void>;

export async function openBrowserURL(url: string): Promise<void> {
    const command = createOpenCommand(url);
    await new Promise<void>((resolve) => {
        const child = spawn(command.name, command.args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.once('error', () => resolve());
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

function createOpenCommand(url: string): { readonly name: string; readonly args: readonly string[] } {
    switch (process.platform) {
        case 'darwin':
            return { name: 'open', args: [url] };
        case 'win32':
            return { name: 'cmd', args: ['/c', 'start', '', url] };
        default:
            return { name: 'xdg-open', args: [url] };
    }
}
