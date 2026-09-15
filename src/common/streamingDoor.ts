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
// STR-27, 2026-09-15 — why the verdict is no longer simply cached for five minutes. It was, and
// that broke playback over the web: play something at home, walk out with the phone, start
// something within the window, and every hlsv2 playlist and segment URL was still built on
// lan.homeiomp.xyz, which resolves to a private address that exists nowhere else. The player
// failed without a single request reaching the server (Caddy saw only stats.json, which does not
// go through the door). A cached "the LAN" is a claim about where the device is standing, and that
// claim expires the moment it moves. So now:
//
//   * The two verdicts age differently. "The tunnel" is true anywhere, so it is trusted for
//     minutes and playback never pays for a probe it does not need. "The LAN" is only true while
//     the device is still at home, so it is worth twenty seconds and is re-checked on the next
//     playback start after that.
//   * Anything that says the network may have moved — online, offline, a Network Information
//     change, the page coming back to the foreground — throws the verdict away immediately, in
//     both directions: it is also how walking back IN the front door is noticed at once.
//   * A LAN door that actually fails a request is abandoned mid-stream (noteStreamingDoorFailure),
//     and held off for two minutes so the retry is built on the tunnel and cannot loop.
//   * A verdict persisted in localStorage is NEVER routed on. It survives only as the line
//     Settings -> Info shows, because a phone from a previous session says nothing about where
//     this device is now.
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
// How long "the LAN" is trusted. Short: it is a statement about where the device is standing, and
// it is the verdict that breaks playback when it goes stale. Long enough that the handful of
// requests one playback start makes do not each trigger a probe.
const LAN_TTL = 20 * 1000;
// How long "the tunnel" is trusted. Long: it is correct everywhere, including at home, where it
// only costs bandwidth. Arriving home is noticed by the network watchers below, not by this
// expiring, so nothing is lost by the generosity.
const TUNNEL_TTL = 5 * 60 * 1000;
// Once the LAN door has actually failed a request, do not offer it again for this long — not even
// if the cheap /settings probe answers, because something between here and the media evidently
// does not work. Cleared by a network change or by tapping the line in Settings -> Info.
const LAN_BLOCK = 2 * 60 * 1000;
// Tap the Info line to write '0' here and the LAN door is never used again on this device.
const OFF_KEY = 'homeiomp.lan';
const RECORD_KEY = 'homeiomp.door.last';

type DoorRecord = {
    at: number,
    // The LAN base to use, or null for "the public door".
    lan: string | null,
    // Human-readable, for Settings -> Info. This is a diagnostic panel on a phone with no console.
    detail: string,
    // Why this verdict was established — 'startup', 'stale', 'network changed (online)', … The
    // owner cannot open a console, so the reason the door last switched is the whole diagnostic.
    reason: string,
};

// The routing decision. Subject to the TTLs above and thrown away by every invalidation.
let record: DoorRecord | null = null;
// The same thing kept purely so Settings -> Info has something to show. NEVER routed on.
let lastVerdict: DoorRecord | null = null;
let inFlight: Promise<DoorRecord> | null = null;
// Wall-clock after which the LAN door may be offered again, following a real failure.
let lanBlockedUntil = 0;
// What the next probe will report as its reason.
let pendingReason = 'startup';
let watching = false;
// window.fetch as it was before the observer below wrapped it, so the door's own probe cannot
// report itself as a LAN failure.
let nativeFetch: typeof fetch | null = null;

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
    lanBlockedUntil = 0;
    pendingReason = 'LAN door switched ' + (enabled ? 'on' : 'off');
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

// Whether a URL — a base, a playlist, a segment — is addressed at the LAN door. The one test a
// caller needs to know that a failed request means "this device is no longer at home".
export const isLanDoorBase = (url: string | null | undefined): boolean => {
    if (typeof url !== 'string' || url.length === 0) return false;
    try {
        return new URL(url).hostname === LAN_HOST;
    } catch (_) {
        return false;
    }
};

const persist = (next: DoorRecord): void => {
    lastVerdict = next;
    try {
        localStorage.setItem(RECORD_KEY, JSON.stringify(next));
    } catch (_) {
        // ignore
    }
};

// Establish a verdict: routed on until it expires or is invalidated.
const write = (next: DoorRecord): DoorRecord => {
    record = next;
    persist(next);
    return next;
};

// Report a verdict without caching it, for the cases that are cheap to recompute and must be
// reconsidered the moment the reason for them goes away (chiefly the post-failure block). Leaving
// `record` null is what makes them self-correcting: streamingServerDoor falls through to the
// configured URL, which is the tunnel, and the next call re-decides from scratch.
const note = (next: DoorRecord): DoorRecord => {
    persist(next);
    return next;
};

const invalidate = (reason: string, unblockLan: boolean): void => {
    record = null;
    pendingReason = reason;
    if (unblockLan) lanBlockedUntil = 0;
};

const fresh = (): DoorRecord | null => {
    if (record === null) return null;
    const ttl = record.lan === null ? TUNNEL_TTL : LAN_TTL;
    return (Date.now() - record.at) < ttl ? record : null;
};

// Everything that means "the network this device is on may have changed". Each one throws the
// verdict away rather than deciding anything: the next playback start probes and finds out.
// Walking out of the house and walking back into it are the same event to this code.
const watchNetwork = (): void => {
    if (watching) return;
    if (typeof window === 'undefined') return;
    watching = true;

    const changed = (what: string) => () => invalidate('network changed (' + what + ')', true);

    try {
        window.addEventListener('online', changed('online'));
        window.addEventListener('offline', changed('offline'));
    } catch (_) {
        // ignore
    }

    try {
        // Network Information API: present on Android Chrome, absent on iOS. Where it exists it is
        // the earliest and most specific signal there is — Wi-Fi to cellular fires it directly.
        const connection = (navigator as any)?.connection;
        if (connection && typeof connection.addEventListener === 'function') {
            connection.addEventListener('change', changed('connection'));
        }
    } catch (_) {
        // ignore
    }

    try {
        // The signal that actually fires on an iPhone. Coming back to a backgrounded tab is the
        // one moment a phone reliably reports, and it is exactly when it has usually moved.
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    invalidate('back in the foreground', true);
                }
            });
        }
    } catch (_) {
        // ignore
    }

    watchFetch();
};

// The player's own requests — the /hlsv2 playlist, its segments, the subtitle conversions — are
// made by the video library and by the <video> element, not from here, so wrapping fetch is the
// only way this module can hear about one of them failing against the LAN host. It observes and
// re-throws; nothing about any request changes. An abort is not a failure (unloading a stream
// aborts its segment fetches as a matter of course), and the door's own probe is exempt because
// it keeps a reference to the unwrapped fetch.
const watchFetch = (): void => {
    try {
        const original = window.fetch;
        if (typeof original !== 'function') return;
        nativeFetch = original;
        window.fetch = function (input: any, init?: any) {
            let url: string | null = null;
            try {
                url = typeof input === 'string' ? input : (input?.url ?? null);
            } catch (_) {
                url = null;
            }
            const result = original.call(window, input, init);
            if (url === null || !isLanDoorBase(url) || typeof result?.catch !== 'function') {
                return result;
            }
            return result.catch((error: any) => {
                if (error?.name !== 'AbortError') {
                    noteStreamingDoorFailure(url as string, String(error?.message ?? error));
                }
                throw error;
            });
        } as typeof fetch;
    } catch (_) {
        // A diagnostic must never break playback.
    }
};

// Ask the LAN door whether it is there. /settings is the streaming server's own cheapest endpoint
// and it is served through the same handle_path as everything else, so a 200 here proves the whole
// path works, not merely that something answers on the host.
const probe = (lan: string, reason: string): Promise<DoorRecord> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    const request = nativeFetch ?? fetch;
    return request(new URL('settings', lan).href, {
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
                reason,
            });
        })
        .catch((error) => write({
            at: Date.now(),
            lan: null,
            detail: 'tunnel — LAN ' + (error?.name === 'AbortError' ? 'timed out' : String(error?.message ?? error)),
            reason,
        }))
        .finally(() => {
            clearTimeout(timer);
            inFlight = null;
        });
};

type EnsureOptions = {
    // Probe now whatever the last verdict was, and forgive a blocked LAN door. This is the
    // Settings -> Info tap: the owner has just walked in and wants to know.
    force?: boolean,
};

// Establish the door. Awaited at every playback start, so the verdict playback is about to build
// its URLs on is never older than the TTLs above; a probe costs at most PROBE_TIMEOUT and only
// runs when the answer is actually stale. Also fired at startup, where nothing waits for it.
export const ensureStreamingDoor = (streamingServerURL: string | null | undefined, options?: EnsureOptions): Promise<DoorRecord> => {
    watchNetwork();

    if (options?.force === true) invalidate('asked again from Settings', true);

    const known = fresh();
    if (known !== null) return Promise.resolve(known);
    if (inFlight !== null) return inFlight;

    if (!isLanDoorEnabled()) {
        return Promise.resolve(write({ at: Date.now(), lan: null, detail: 'tunnel — LAN door switched off', reason: pendingReason }));
    }

    const lan = lanDoorFor(streamingServerURL);
    if (lan === null) {
        return Promise.resolve(write({ at: Date.now(), lan: null, detail: 'no LAN door for this server', reason: pendingReason }));
    }

    const heldFor = lanBlockedUntil - Date.now();
    if (heldFor > 0) {
        // Deliberately not cached: the moment the block lapses the next playback probes again.
        return Promise.resolve(note({
            at: Date.now(),
            lan: null,
            detail: 'tunnel — LAN door held off after a failure (' + Math.ceil(heldFor / 1000) + 's)',
            reason: pendingReason,
        }));
    }

    inFlight = probe(lan, pendingReason);
    return inFlight;
};

// The base the player should actually use. Synchronous by design: playback must never wait on the
// probe, so an unfinished, expired or invalidated one simply yields the public door.
export const streamingServerDoor = (streamingServerURL: string | null | undefined): string | null | undefined => {
    const known = fresh();
    if (known === null || known.lan === null) return streamingServerURL;
    return known.lan === lanDoorFor(streamingServerURL) ? known.lan : streamingServerURL;
};

// A request built on the LAN door failed. Called from the player's error handler and from the
// fetch observer above, and it is the whole mid-stream correction: the verdict becomes "the
// tunnel" at once — synchronously, so the very next streamingServerDoor() is already correct —
// and the LAN door is held off long enough that the retry cannot be built on it again.
//
// Returns whether the caller was in fact on the LAN door, which is how the player decides between
// retrying quietly and showing the owner an error.
export const noteStreamingDoorFailure = (url: string | null | undefined, why: string): boolean => {
    if (!isLanDoorBase(url)) return false;
    lanBlockedUntil = Date.now() + LAN_BLOCK;
    pendingReason = 'LAN door failed a request';
    // Dropping the verdict rather than replacing it with a cached "tunnel" is what makes this
    // recover on its own: streamingServerDoor falls through to the configured URL — the tunnel —
    // from this instant, and the moment the block lapses the next playback probes again instead of
    // sitting on a five-minute-old conclusion.
    record = null;
    note({
        at: Date.now(),
        lan: null,
        detail: 'tunnel — LAN door failed: ' + why,
        reason: pendingReason,
    });
    return true;
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

// The last verdict this session made, or failing that whatever a previous session left behind.
// Used ONLY by the report: a record written before this page loaded says where the phone was
// then, which is worth showing and worth nothing at all for routing (STR-27).
const lastReport = (): { last: DoorRecord, live: boolean, routing: boolean } | null => {
    if (lastVerdict !== null) {
        return { last: lastVerdict, live: true, routing: record === lastVerdict && fresh() !== null };
    }
    try {
        const raw = localStorage.getItem(RECORD_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as DoorRecord;
        return typeof parsed?.at === 'number' ? { last: parsed, live: false, routing: false } : null;
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
// requests on, when that was last established and what established it.
export const streamingDoorReport = (streamingServerURL: string | null | undefined): string => {
    const base = streamingServerDoor(streamingServerURL);
    const head = typeof base === 'string' && base.length > 0 ? base : 'no streaming server';
    const report = lastReport();
    if (report === null) return head + ' (not probed yet)';
    // The head is what playback would use if it started this second; the rest is where that came
    // from. When the two can disagree — an expired verdict, or one from a previous session — say
    // so, rather than leaving the owner to reconcile a "LAN" line against a tunnel URL.
    const tail = !report.live ?
        ' — previous session, re-probed on play'
        :
        report.routing ? '' : ' — expired, re-probed on play';
    return head + ' · ' + report.last.detail + ' · ' + report.last.reason + ' (' + ago(report.last.at) + ')' + tail;
};
