import { describe, expect, it } from 'vitest';
import {
    sessionControlTransportForPlatform,
    windowsSessionControlProxyInvocation,
} from './session-control-platform.js';

describe('session control platform transport', () => {
    it('routes Windows production ownership through the native named-pipe proxy', () => {
        // Given
        const sidecarCommand = 'C:\\Program Files\\Mission Control\\mission-control-sidecar.exe';

        // When
        const transport = sessionControlTransportForPlatform('win32');
        const invocation = windowsSessionControlProxyInvocation(sidecarCommand);

        // Then
        expect(transport).toBe('windows_proxy');
        expect(invocation).toEqual({ command: sidecarCommand, args: ['session-control-proxy'] });
        expect(sessionControlTransportForPlatform('linux')).toBe('posix_socket');
        expect(sessionControlTransportForPlatform('darwin')).toBe('posix_socket');
    });
});
