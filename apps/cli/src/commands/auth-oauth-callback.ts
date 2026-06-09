import { createServer, type Server, type ServerResponse } from 'node:http';

export async function waitForCallbackCode(
    port: number,
    state: string,
): Promise<{
    readonly code: Promise<string>;
    readonly port: number;
    readonly close: () => Promise<void>;
}> {
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (error: Error) => void = () => undefined;
    const code = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://localhost:${port}`);
        handleCallback(url, response, state, resolveCode, rejectCode);
    });
    await listen(server, port);
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        await closeServer(server);
        throw new Error('OAuth callback server did not bind to a TCP port');
    }
    return {
        code,
        port: address.port,
        close: () => closeServer(server),
    };
}

function handleCallback(
    url: URL,
    response: ServerResponse,
    expectedState: string,
    resolveCode: (code: string) => void,
    rejectCode: (error: Error) => void,
): void {
    if (url.pathname !== '/auth/callback') {
        response.writeHead(404);
        response.end('Not found');
        return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code === null || state !== expectedState) {
        rejectCode(new Error('Invalid OAuth callback'));
        response.writeHead(400);
        response.end('Authorization failed');
        return;
    }
    resolveCode(code);
    response.writeHead(200);
    response.end('Authorization complete. You can close this window.');
}

function listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, resolve);
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error !== undefined) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
