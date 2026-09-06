// HomeIomp: keep the screen on while a video is actually playing.
//
// Inline playback — the player page rather than the platform's own fullscreen video — gets no
// sleep prevention from the browser, so a phone lying on a table dims and locks in the middle of a
// film. The Screen Wake Lock API is the standard cure and iOS has had it since 16.4; every browser
// that does not have it takes the no-op path here and behaves exactly as it did before.
//
// Two rules the API enforces and this file therefore obeys: a lock is released automatically as
// soon as the document is hidden (so it has to be re-taken on the way back), and a request from a
// hidden document is rejected outright (so we never make one). Pausing releases it deliberately —
// a paused film should not hold the screen awake.

import { useEffect } from 'react';

type Sentinel = {
    released: boolean,
    release: () => Promise<void>,
    addEventListener: (type: string, listener: () => void) => void,
};

let sentinel: Sentinel | null = null;
let lastResult = 'not requested';

const api = (): any => (
    typeof navigator !== 'undefined' ? (navigator as any).wakeLock ?? null : null
);

export const isWakeLockSupported = (): boolean => api() !== null;

const request = async (): Promise<void> => {
    const wakeLock = api();
    if (wakeLock === null || sentinel !== null) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    try {
        const next = await wakeLock.request('screen') as Sentinel;
        sentinel = next;
        lastResult = 'held';
        // The platform releases the lock on its own whenever the document is hidden; forget the
        // sentinel then, so the next visibility change can take a fresh one.
        next.addEventListener('release', () => {
            if (sentinel === next) {
                sentinel = null;
                lastResult = 'released by the system';
            }
        });
    } catch (error: any) {
        sentinel = null;
        lastResult = 'refused (' + (error?.name ?? 'error') + ')';
    }
};

const release = (): void => {
    const current = sentinel;
    sentinel = null;
    if (current === null) return;
    lastResult = 'released';
    current.release().catch(() => {
        // Already gone; nothing to do.
    });
};

export const wakeLockReport = (): string => (
    isWakeLockSupported() ? lastResult : 'not supported here'
);

// Hold the screen awake while `active`. Safe to call unconditionally: on a platform without the
// API, or with active=false, it does nothing at all.
export const useWakeLock = (active: boolean): void => {
    useEffect(() => {
        if (!isWakeLockSupported()) return;

        if (!active) {
            release();
            return;
        }

        request();

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') request();
        };

        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            release();
        };
    }, [active]);
};
