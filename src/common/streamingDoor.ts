// HomeIomp: which door this device reaches the streaming server through, and the record of how
// that was decided.
//
// The streaming server has two addresses. The public one — https://homeiomp.xyz/stremio-server/ —
// works from anywhere and rides the Cloudflare tunnel, which means every byte of a film leaves the
// house and comes back. The LAN one — https://lan.homeiomp.xyz/stremio-server/ — is the same
// container, one hop away over the home network, and it only resolves and only answers while the
// device is actually at home.
//
// So the choice cannot be a setting: it depends on where the phone is standing right now. It is a
// probe instead. If the LAN door answers within a second and a half, playback uses it; otherwise
// nothing happens at all and the public door is used exactly as before. A failing probe is the
// normal case away from home, never an error, and never a reason a video does not start.
//
// The DNS caveat that makes the probe mandatory rather than a nicety: lan.homeiomp.xyz is a public
// A record pointing at a private address, and consumer routers rebind-filter exactly that. The PC
// carries a hosts entry; the phone may or may not resolve it, depending on what its DHCP hands out.
// Nothing here assumes an answer either way.
//
// CORS: the LAN vhost already returns Access-Control-Allow-Origin for https://homeiomp.xyz on
// every response (and answers the preflight), so the probe, the /hlsv2/probe JSON and the subtitle
// fetches are all readable cross-origin. The <video> element carries no crossorigin attribute, so
// the media itself never needed it.

const LAN_HOST = 'lan.homeiomp.xyz';
// The public hosts whose /stremio-server the LAN door mirrors. Any other streaming server — a
// desktop's own 127.0.0.1:11470, someone else's box — is left alone.
const PUBLIC_HOSTS = ['homeiomp.xyz', 'www.homeiomp.xyz'];
const DOOR_PATH_PREFIX = '/stremio-server';
const PROBE_TIMEOUT = 1500;
// How long a verdict is trusted before it is probed again. Long enough that a film does not
// re-probe mid-session, short enough that leaving the house is noticed by the next playback.
const PROBE_TTL = 5 * 60 * 1000;
// Tap the Info line to write '0' here and the LAN door is never used again on this device.
const OFF_KEY = 'homeiomp.lan';
const RECORD_KEY = 'homeiomp.door.last';

type DoorRecord = {
    at: number,
    // The LAN base to use, or null for "the public door".
    lan: string | null,
    // Human-readable, for Settings -> Info. This is a diagnostic panel on a phone with no console.
    detail: string,
};

let record: DoorRecord | null = null;
let inFlight: Promise<DoorRecord> | null = null;

export const isLanDoorEnabled = (): boolean => {
    try {
        return localStorage.getItem(OFF_KEY) !== '0';
    } catch (_) {
        return true;
    }
};

export const setLanDoorEnabled = (enabled: boolean): void => {
    try {
        if (enabled) localStorage.removeItem(OFF_KEY);
        else localStorage.setItem(OFF_KEY, '0');
    } catch (_) {
        // A diagnostic must never break playback.
    }
    record = null;
};

// The LAN address of a given streaming server, or null when there is no such thing for it.
export const lanDoorFor = (streamingServerURL: string | null | undefined): string | null => {
    if (typeof streamingServerURL !== 'string' || streamingServerURL.length === 0) return null;
    try {
        const parsed = new URL(streamingServerURL);
        if (parsed.protocol !== 'https:') return null;
        if (!PUBLIC_HOSTS.includes(parsed.hostname)) return null;
        if (!parsed.pathname.startsWith(DOOR_PATH_PREFIX)) return null;
        parsed.hostname = LAN_HOST;
        return parsed.href;
    } catch (_) {
        return null;
    }
};

const write = (next: DoorRecord): DoorRecord => {
    record = next;
    try {
        localStorage.setItem(RECORD_KEY, JSON.stringify(next));
    } catch (_) {
        // ignore
    }
    return next;
};

const fresh = (): DoorRecord | null => (
    record !== null && (Date.now() - record.at) < PROBE_TTL ? record : null
);

// Ask the LAN door whether it is there. /settings is the streaming server's own cheapest endpoint
// and it is served through the same handle_path as everything else, so a 200 here proves the whole
// path works, not merely that something answers on the host.
const probe = (lan: string): Promise<DoorRecord> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    return fetch(new URL('settings', lan).href, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
    })
        .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return write({
                at: Date.now(),
                lan,
                detail: 'LAN (' + (Date.now() - started) + 'ms)',
            });
        })
        .catch((error) => write({
            at: Date.now(),
            lan: null,
            detail: 'tunnel — LAN ' + (error?.name === 'AbortError' ? 'timed out' : String(error?.message ?? error)),
        }))
        .finally(() => {
            clearTimeout(timer);
            inFlight = null;
        });
};

// Kick a probe off if the answer is stale. Fire and forget: nothing waits on it, and whatever it
// learns applies to the next thing that asks.
export const ensureStreamingDoor = (streamingServerURL: string | null | undefined): Promise<DoorRecord> => {
    const known = fresh();
    if (known !== null) return Promise.resolve(known);
    if (inFlight !== null) return inFlight;

    if (!isLanDoorEnabled()) {
        return Promise.resolve(write({ at: Date.now(), lan: null, detail: 'tunnel — LAN door switched off' }));
    }

    const lan = lanDoorFor(streamingServerURL);
    if (lan === null) {
        return Promise.resolve(write({ at: Date.now(), lan: null, detail: 'no LAN door for this server' }));
    }

    inFlight = probe(lan);
    return inFlight;
};

// The base the player should actually use. Synchronous by design: playback must never wait on the
// probe, so an unfinished or failed one simply yields the public door.
export const streamingServerDoor = (streamingServerURL: string | null | undefined): string | null | undefined => {
    const known = fresh();
    if (known === null || known.lan === null) return streamingServerURL;
    return known.lan === lanDoorFor(streamingServerURL) ? known.lan : streamingServerURL;
};

// The HEVC switch. The key is READ BY THE PLAYER LIBRARY — patches/@stremio__stremio-video, in
// withStreamingServer.js — which is what actually advertises the codec to the streaming server;
// this end only shows the switch and flips it. On means an iPhone asks for x265 to be passed
// through untouched instead of re-encoded to H.264 for the length of the film. It only has any
// effect on the native-HLS path.
//
// OFF BY DEFAULT since 2026-09-07, and it has to stay that way until the server changes. The
// passthrough works exactly as designed — the server stops transcoding and copies the track — but
// its ffmpeg writes the fMP4 sample entry as 'hev1', and WebKit decodes only the 'hvc1' spelling.
// The element fetches the init segment and two fragments and then sits there showing nothing: no
// error, no frames, which reads on the phone as "won't stream even though it's cached". The
// switch stays here so the fix can be tried from the sofa once the server tags hvc1.
const HEVC_KEY = 'homeiomp.hevc';

export const isHevcPassthroughEnabled = (): boolean => {
    try {
        return localStorage.getItem(HEVC_KEY) === '1';
    } catch (_) {
        return false;
    }
};

export const setHevcPassthroughEnabled = (enabled: boolean): void => {
    try {
        if (enabled) localStorage.setItem(HEVC_KEY, '1');
        else localStorage.removeItem(HEVC_KEY);
    } catch (_) {
        // A diagnostic must never break playback.
    }
};

// The same test the player library makes to decide whether it can run hls.js — see
// @stremio/stremio-video src/nativeHlsOnly.js, which this deliberately mirrors rather than imports
// (the library is CommonJS and this file is only reporting, never deciding).
export const isNativeHlsOnly = (): boolean => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if ((window as any).MediaSource || (window as any).WebKitMediaSource) return false;
    const probeElement = document.createElement('video');
    return typeof probeElement.canPlayType === 'function' &&
        probeElement.canPlayType('application/vnd.apple.mpegurl') !== '';
};

export const playbackPathReport = (): string => (
    isNativeHlsOnly() ? 'native HLS (WebKit)' : 'MSE (hls.js)'
);

const load = (): DoorRecord | null => {
    if (record !== null) return record;
    try {
        const raw = localStorage.getItem(RECORD_KEY);
        return raw ? JSON.parse(raw) as DoorRecord : null;
    } catch (_) {
        return null;
    }
};

const ago = (at: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
};

// What Settings -> Info shows: the door in use, the base URL playback will actually build its
// requests on, and when that was last established.
export const streamingDoorReport = (streamingServerURL: string | null | undefined): string => {
    const last = load();
    const base = streamingServerDoor(streamingServerURL);
    const head = typeof base === 'string' && base.length > 0 ? base : 'no streaming server';
    if (last === null) return head + ' (not probed yet)';
    return head + ' · ' + last.detail + ' (' + ago(last.at) + ')';
};
