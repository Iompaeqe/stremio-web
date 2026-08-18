// HomeIomp: the one door between this web UI and the native iOS app that hosts it.
//
// The app loads https://homeiomp.xyz/stremio in a WKWebView, registers a script message
// handler called 'homeiomp', and injects, at document start:
//
//     window.__HOMEIOMP_APP__ = { platform: 'ios', version: '1' };
//
// Everything here is gated on that marker. In a normal browser isHomeIompApp() is false, no
// affordance renders, no message is ever posted, and the page behaves exactly as it did
// before this file existed - which is the whole point: one deployment serves both.
//
// Page -> app is window.webkit.messageHandlers.homeiomp.postMessage(message). WKWebView will
// only carry values it can serialise, so every message is run through a JSON round trip
// before it is handed over: a Date (the core hands us real Date objects for release dates)
// becomes an ISO string, undefined disappears, and anything exotic would throw here, where it
// is caught, rather than silently dropping the message.
//
// App -> page is window.homeiompApp.onEvent(json), installed below. It takes either an object
// or a JSON string, because evaluating JavaScript from Swift usually means building a string
// anyway. The only event the UI reacts to today is downloadState; the last one received is
// cached so a row that mounts later can paint the right badge without waiting for a push.
//
// See docs/homeiomp-bridge.md for the full schema and a snippet that fakes the app in a
// desktop browser.

import { useCallback, useEffect, useState } from 'react';

const HANDLER_NAME = 'homeiomp';
export const BRIDGE_VERSION = 1;

export type HomeIompAppInfo = {
    platform: string,
    version: string,
};

export type DownloadState = {
    id: string,
    // queued | downloading | paused | done | failed | server, plus whatever the app invents
    // later: an unknown state renders as a neutral badge rather than nothing.
    //
    // 'server' means the episode is prepared on the server but is not on this device — the
    // badge says so and the button stays tappable, because tapping is how it gets fetched.
    // 'removed' is not a state: it deletes the id (see dispatch), so the row goes back to a
    // plain Download button.
    state: string,
    progress?: number,
};

type AppEvent = {
    type: string,
    [key: string]: any,
};

type EventHandler = (event: AppEvent) => void;

// Is this page inside the HomeIomp app? The injected marker is the authority; the message
// handler is accepted on its own too, so an app build that registers the handler without the
// marker still lights the UI up instead of looking broken.
export const homeIompAppInfo = (): HomeIompAppInfo | null => {
    if (typeof window === 'undefined') return null;
    const info = (window as any).__HOMEIOMP_APP__;
    if (!info || typeof info !== 'object') return null;
    return {
        platform: typeof info.platform === 'string' ? info.platform : 'unknown',
        version: typeof info.version === 'string' ? info.version : String(info.version ?? ''),
    };
};

const messageHandler = (): any => {
    if (typeof window === 'undefined') return null;
    const handler = (window as any).webkit?.messageHandlers?.[HANDLER_NAME];
    return handler && typeof handler.postMessage === 'function' ? handler : null;
};

export const isHomeIompApp = (): boolean => homeIompAppInfo() !== null || messageHandler() !== null;

// Post a message to the app. Returns whether it was handed over, so a caller can tell the
// user "the app did not take that" instead of leaving a tap with no outcome. Never throws:
// a missing handler is a no-op, and a payload WKWebView refuses is swallowed here.
export const postToApp = (type: string, payload?: Record<string, any>): boolean => {
    const handler = messageHandler();
    if (!handler) return false;
    try {
        const message = JSON.parse(JSON.stringify({ type, ...(payload ?? {}) }));
        handler.postMessage(message);
        return true;
    } catch (error) {
        console.error('homeiomp bridge: message refused', error);
        return false;
    }
};

const listeners = new Map<string, Set<EventHandler>>();
const downloadStates = new Map<string, DownloadState>();

const dispatch = (event: AppEvent): void => {
    if (event.type === 'downloadState' && Array.isArray(event.items)) {
        for (const item of event.items) {
            if (!item || typeof item.id !== 'string') continue;
            // 'removed' is the app saying the download is gone - cancelled, deleted, reaped.
            // The id is dropped rather than remembered as a state, so the row returns to a
            // plain Download button instead of being stuck describing something that no
            // longer exists. It is the only way back to "no state" the app has.
            if (item.state === 'removed') {
                downloadStates.delete(item.id);
                continue;
            }
            downloadStates.set(item.id, {
                id: item.id,
                state: typeof item.state === 'string' ? item.state : 'unknown',
                progress: typeof item.progress === 'number' ? item.progress : undefined,
            });
        }
    }

    for (const type of [event.type, '*']) {
        const handlers = listeners.get(type);
        if (!handlers) continue;
        for (const handler of Array.from(handlers)) {
            try {
                handler(event);
            } catch (error) {
                console.error('homeiomp bridge: handler failed for ' + event.type, error);
            }
        }
    }
};

// Subscribe to an event type, or to '*' for all of them. Returns the unsubscribe function,
// which is what a React effect wants to return.
export const onAppEvent = (type: string, handler: EventHandler): (() => void) => {
    const handlers = listeners.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    listeners.set(type, handlers);
    return () => {
        handlers.delete(handler);
    };
};

const install = (): void => {
    if (typeof window === 'undefined') return;
    (window as any).homeiompApp = {
        version: BRIDGE_VERSION,
        onEvent: (raw: unknown): boolean => {
            let event: any = raw;
            if (typeof raw === 'string') {
                try {
                    event = JSON.parse(raw);
                } catch (error) {
                    console.error('homeiomp bridge: event is not JSON', error);
                    return false;
                }
            }
            if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
                console.error('homeiomp bridge: event has no type');
                return false;
            }
            dispatch(event as AppEvent);
            return true;
        },
    };
};

install();

export const downloadStateOf = (id: string | null): DownloadState | null => {
    return id ? downloadStates.get(id) ?? null : null;
};

// The state of one download, kept in step with the app's pushes. Cheap enough to call from
// every stream row: it re-renders only when that row's own state or progress changes.
export const useDownloadState = (id: string | null): DownloadState | null => {
    const [state, setState] = useState<DownloadState | null>(() => downloadStateOf(id));

    const sync = useCallback(() => {
        const next = downloadStateOf(id);
        setState((previous) => (
            previous?.state === next?.state && previous?.progress === next?.progress ?
                previous
                :
                next
        ));
    }, [id]);

    useEffect(() => {
        sync();
        return onAppEvent('downloadState', sync);
    }, [sync]);

    return state;
};

type CoreStream = {
    name?: string,
    title?: string,
    description?: string,
    infoHash?: string,
    fileIdx?: number,
    url?: string,
    ytId?: string,
    externalUrl?: string,
    // The addon protocol calls the tracker list 'sources'; stremio-core deserialises it into
    // 'announce'. Both are read, and it is posted under the protocol's name.
    sources?: string[],
    announce?: string[],
    behaviorHints?: Record<string, any>,
    subtitles?: { id?: string, lang?: string, url?: string }[],
    [key: string]: any,
};

type CoreVideo = {
    id: string,
    title?: string,
    season?: number,
    episode?: number,
    released?: Date | string | null,
    thumbnail?: string | null,
    [key: string]: any,
};

type CoreMeta = {
    id: string,
    type: string,
    name?: string,
    poster?: string | null,
    background?: string | null,
    videos?: CoreVideo[],
    [key: string]: any,
};

type CoreAddon = {
    transportUrl?: string,
    // resources is either ['subtitles', 'stream'] or [{ name: 'subtitles', types, idPrefixes }],
    // and the same collection really does contain both shapes.
    manifest?: { name?: string, resources?: any[] },
    [key: string]: any,
};

const asIso = (value: Date | string | null | undefined): string | null => {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
    return typeof value === 'string' && value.length > 0 ? value : null;
};

const asText = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

// The id both sides use to talk about one download. The app must echo exactly this in its
// downloadState items or the badge will never find its row. Source-derived rather than
// random so it survives a reload: the same stream on the same episode is the same download.
export const downloadItemId = (videoId: string | null | undefined, stream: CoreStream): string => {
    const source = typeof stream.infoHash === 'string' ?
        stream.infoHash + ':' + (typeof stream.fileIdx === 'number' ? stream.fileIdx : '')
        :
        asText(stream.url) ?? asText(stream.ytId) ?? asText(stream.externalUrl) ?? '';
    return (videoId ?? '') + '|' + source;
};

export type DownloadScope = 'episode' | 'season';

// One subtitle file the app may fetch and mux into the download. `source` is the addon that
// offered it, kept only so a human reading the app's list can tell OpenSubtitles from the
// release's own track.
export type DownloadSubtitle = {
    lang: string | null,
    url: string,
    source: string | null,
};

// A subtitle-capable addon, reduced to what the app needs to ask it the same question for the
// other episodes of a season.
export type SubtitleAddon = {
    transportUrl: string,
    name: string | null,
};

// Subtitles are small - a season of them is a rounding error against one 2 GB episode - so a
// handful travel with every download. Five is the owner's "top 3-5", and it is also about as
// many as anyone scrolls through in a player's subtitle menu.
export const MAX_DOWNLOAD_SUBTITLES = 5;
// A download must not wait on somebody else's free public addon. Four seconds is long enough
// for a warm OpenSubtitles and short enough that a dead addon is not felt as a broken button.
const SUBTITLE_FETCH_TIMEOUT_MS = 4000;
// A collection with thirty subtitle addons in it would otherwise mean thirty requests per tap.
const MAX_SUBTITLE_ADDONS = 8;

const ENGLISH_TAGS = new Set(['en', 'eng', 'english']);

// Addons tag English as 'en', 'eng', 'English' and occasionally 'en-US'; ISO-639-2 and the
// bare name are both in the wild, so all of them are accepted and nothing else is.
const isEnglish = (lang: unknown): boolean => {
    if (typeof lang !== 'string') return false;
    const value = lang.trim().toLowerCase();
    return ENGLISH_TAGS.has(value) || ENGLISH_TAGS.has(value.split(/[-_]/)[0]);
};

const declaresSubtitles = (addon: CoreAddon | null | undefined): boolean => {
    const resources = addon?.manifest?.resources;
    if (!Array.isArray(resources)) return false;
    return resources.some((resource: any) => (
        typeof resource === 'string' ?
            resource === 'subtitles'
            :
            resource !== null && typeof resource === 'object' && resource.name === 'subtitles'
    ));
};

// Every installed addon that says it serves subtitles, in the order the user installed them -
// which is the order they are asked in, so OpenSubtitles comes first when it is present.
export const subtitleAddons = (addons: CoreAddon[] | null | undefined): SubtitleAddon[] => {
    if (!Array.isArray(addons)) return [];
    return addons
        .filter((addon) => typeof addon?.transportUrl === 'string' && addon.transportUrl.length > 0 && declaresSubtitles(addon))
        .slice(0, MAX_SUBTITLE_ADDONS)
        .map((addon) => ({
            transportUrl: addon.transportUrl as string,
            name: asText(addon.manifest?.name),
        }));
};

// 'https://opensubtitles.strem.io/manifest.json' -> '.../subtitles/series/tt0944947%3A1%3A1.json'.
// A configured addon carries its settings in the path, which is why the manifest filename is
// stripped rather than the host being rebuilt.
export const subtitlesResourceUrl = (transportUrl: string, type: string, videoId: string): string => {
    const base = transportUrl.trim().replace(/manifest\.json$/, '');
    const root = base.endsWith('/') ? base : base + '/';
    return root + 'subtitles/' + encodeURIComponent(type) + '/' + encodeURIComponent(videoId) + '.json';
};

const dedupeSubtitles = (subtitles: DownloadSubtitle[]): DownloadSubtitle[] => {
    const seen = new Set<string>();
    const kept: DownloadSubtitle[] = [];
    for (const subtitle of subtitles) {
        if (!subtitle || typeof subtitle.url !== 'string' || subtitle.url.length === 0) continue;
        if (seen.has(subtitle.url)) continue;
        seen.add(subtitle.url);
        kept.push(subtitle);
        if (kept.length >= MAX_DOWNLOAD_SUBTITLES) break;
    }
    return kept;
};

const fetchAddonSubtitles = async (addon: SubtitleAddon, type: string, videoId: string): Promise<DownloadSubtitle[]> => {
    if (typeof fetch !== 'function') return [];
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller !== null ? setTimeout(() => controller.abort(), SUBTITLE_FETCH_TIMEOUT_MS) : null;
    try {
        const response = await fetch(subtitlesResourceUrl(addon.transportUrl, type, videoId), {
            headers: { accept: 'application/json' },
            signal: controller !== null ? controller.signal : undefined,
        });
        if (!response.ok) return [];
        const body: any = await response.json();
        const offered: any[] = Array.isArray(body?.subtitles) ? body.subtitles : [];
        return offered
            .filter((subtitle: any) => subtitle && typeof subtitle.url === 'string' && subtitle.url.length > 0 && isEnglish(subtitle.lang))
            .map((subtitle: any) => ({
                lang: asText(subtitle.lang),
                url: subtitle.url as string,
                source: addon.name,
            }));
    } catch {
        // An addon that is slow, down, or refuses the page's origin must never stop a
        // download: the episode is the point, the subtitles are a bonus.
        return [];
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
};

// Ask every subtitle-capable addon for this video and keep the first few English tracks.
//
// Called ONLY when the user taps Download, never on render: this is one request per installed
// subtitle addon, and a stream list is dozens of rows. Never rejects - a failed addon
// contributes nothing and the download goes ahead without it.
export const fetchEnglishSubtitles = async (
    addons: SubtitleAddon[],
    { type, videoId }: { type: string | null | undefined, videoId: string | null | undefined },
): Promise<DownloadSubtitle[]> => {
    if (!Array.isArray(addons) || addons.length === 0) return [];
    if (typeof videoId !== 'string' || videoId.length === 0) return [];
    const resourceType = typeof type === 'string' && type.length > 0 ? type : 'series';
    try {
        const answers = await Promise.all(
            addons.map((addon) => fetchAddonSubtitles(addon, resourceType, videoId))
        );
        // Addon order is preserved by concatenating in order, so the first installed addon
        // that has English wins the top slots.
        return dedupeSubtitles(([] as DownloadSubtitle[]).concat(...answers));
    } catch {
        return [];
    }
};

// Build the payload for a 'download' message. Deliberately lossy: it carries what the app
// needs to fetch and file the video, not the core's whole model. A stream with no infoHash
// (a direct url, a YouTube id, an external link) is posted all the same with infoHash null -
// deciding what it can do with that is the app's job, not this UI's.
export const buildDownloadPayload = ({ scope, meta, video, stream, addon, subtitles, addons }: {
    scope: DownloadScope,
    meta: CoreMeta | null,
    video: CoreVideo | null,
    stream: CoreStream,
    addon: CoreAddon | null,
    // Already resolved by the caller (fetchEnglishSubtitles) - this function stays synchronous
    // and free of I/O so it can still be reasoned about from a test or a console.
    subtitles?: DownloadSubtitle[],
    addons?: SubtitleAddon[],
}): Record<string, any> => ({
    scope,
    id: downloadItemId(video?.id ?? meta?.id, stream),
    meta: meta ? {
        id: meta.id,
        type: meta.type,
        name: asText(meta.name),
        poster: asText(meta.poster),
        background: asText(meta.background),
        videos: Array.isArray(meta.videos) ? meta.videos.map((item) => ({
            id: item.id,
            season: typeof item.season === 'number' ? item.season : null,
            episode: typeof item.episode === 'number' ? item.episode : null,
            title: asText(item.title),
            released: asIso(item.released),
            thumbnail: asText(item.thumbnail),
        })) : [],
    } : null,
    video: video ? {
        id: video.id,
        season: typeof video.season === 'number' ? video.season : null,
        episode: typeof video.episode === 'number' ? video.episode : null,
        title: asText(video.title),
        released: asIso(video.released),
    } : null,
    stream: {
        name: asText(stream.name),
        title: asText(stream.title),
        description: asText(stream.description),
        infoHash: asText(stream.infoHash),
        fileIdx: typeof stream.fileIdx === 'number' ? stream.fileIdx : null,
        url: asText(stream.url),
        ytId: asText(stream.ytId),
        externalUrl: asText(stream.externalUrl),
        sources: Array.isArray(stream.sources) ?
            stream.sources
            :
            Array.isArray(stream.announce) ? stream.announce : [],
        behaviorHints: stream.behaviorHints ?? {},
    },
    addon: addon ? {
        transportUrl: asText(addon.transportUrl),
        name: asText(addon.manifest?.name),
    } : null,
    // The stream's own subtitles first - they were authored against this exact release, so
    // they are the ones most likely to be in sync - then whatever the addons offered.
    subtitles: dedupeSubtitles([
        ...(Array.isArray(stream.subtitles) ?
            stream.subtitles
                .filter((subtitle) => subtitle && typeof subtitle.url === 'string')
                .map((subtitle) => ({
                    lang: asText(subtitle.lang),
                    url: subtitle.url as string,
                    source: asText(addon?.manifest?.name),
                }))
            :
            []),
        ...(Array.isArray(subtitles) ? subtitles : []),
    ]),
    // Every subtitle-capable addon, so the app can ask the same question per episode when it
    // resolves the rest of a season. The page deliberately does not walk a season itself.
    addons: Array.isArray(addons) ? addons : [],
});
