import { describe, expect, it } from 'vitest';
import { resolveMissionControlDataDir } from './data-dir.js';

describe('resolveMissionControlDataDir', () => {
    it('uses MCTRL_DATA_DIR before platform fallbacks', () => {
        // Given
        const env = {
            MCTRL_DATA_DIR: '/tmp/mctrl-data',
            XDG_DATA_HOME: '/tmp/xdg-data',
        };

        // When
        const dataDir = resolveMissionControlDataDir({
            env,
            homeDir: '/home/example',
            platform: 'linux',
        });

        // Then
        expect(dataDir).toBe('/tmp/mctrl-data');
    });

    it('uses XDG_DATA_HOME on linux when MCTRL_DATA_DIR is absent', () => {
        // Given
        const env = {
            XDG_DATA_HOME: '/tmp/xdg-data',
        };

        // When
        const dataDir = resolveMissionControlDataDir({
            env,
            homeDir: '/home/example',
            platform: 'linux',
        });

        // Then
        expect(dataDir).toBe('/tmp/xdg-data/mission-control');
    });

    it('uses platform application-data paths when no override is present', () => {
        // Given
        const env = {};

        // When
        const macDataDir = resolveMissionControlDataDir({
            env,
            homeDir: '/Users/example',
            platform: 'darwin',
        });
        const windowsDataDir = resolveMissionControlDataDir({
            env,
            homeDir: 'C:\\Users\\Example',
            platform: 'win32',
        });

        // Then
        expect(macDataDir).toBe('/Users/example/Library/Application Support/mission-control');
        expect(windowsDataDir).toBe('C:\\Users\\Example/AppData/Roaming/mission-control');
    });
});
