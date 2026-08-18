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
    // queued | downloading | paused | done | failed, plus whatever the app invents later:
    // an unknown state renders as a neutral badge rather than nothing.
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
    manifest?: { name?: string },
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

// Build the payload for a 'download' message. Deliberately lossy: it carries what the app
// needs to fetch and file the video, not the core's whole model. A stream with no infoHash
// (a direct url, a YouTube id, an external link) is posted all the same with infoHash null -
// deciding what it can do with that is the app's job, not this UI's.
export const buildDownloadPayload = ({ scope, meta, video, stream, addon }: {
    scope: DownloadScope,
    meta: CoreMeta | null,
    video: CoreVideo | null,
    stream: CoreStream,
    addon: CoreAddon | null,
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
    subtitles: Array.isArray(stream.subtitles) ?
        stream.subtitles
            .filter((subtitle) => subtitle && typeof subtitle.url === 'string')
            .map((subtitle) => ({ lang: asText(subtitle.lang), url: subtitle.url as string }))
        :
        [],
});
