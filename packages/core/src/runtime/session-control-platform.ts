export type SessionControlTransport = 'posix_socket' | 'windows_proxy';

export function sessionControlTransportForPlatform(platform: NodeJS.Platform): SessionControlTransport {
    return platform === 'win32' ? 'windows_proxy' : 'posix_socket';
}

export function windowsSessionControlProxyInvocation(sidecarCommand: string): {
    readonly command: string;
    readonly args: readonly ['session-control-proxy'];
} {
    return { command: sidecarCommand, args: ['session-control-proxy'] };
}
