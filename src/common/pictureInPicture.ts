// HomeIomp: Picture-in-Picture on iOS, and the record of whether the platform allowed it.
//
// iOS does not implement the standard Picture-in-Picture API on the video element; it has
// WebKit's presentation-mode API instead - webkitSupportsPresentationMode('picture-in-picture')
// to ask, webkitSetPresentationMode(...) to enter or leave. Only that API is used here, so
// every browser that does not have it (every desktop browser we ship to) is left exactly as
// it was: the support check returns false, the button never renders, nothing is recorded.
//
// The known catch, and the reason this file records as much as it does: a home screen web
// app in standalone display mode is widely reported not to get Picture-in-Picture at all -
// no glyph in the native player, and requestPictureInPicture()/setPresentationMode refused -
// while the identical page in a Safari tab is fine. If that is what this phone does, the
// record below says so in as many words, on the device, with its own iOS version, instead of
// us arguing from other people's forum posts.

const KEY = 'homeiomp.pip.last';

type Record = {
    at: number,
    why: string,
    supported: boolean,
    standalone: boolean,
    mode: string,
    err?: string,
};

// True when the page is running as an installed/home screen app rather than in a browser tab.
// navigator.standalone is the iOS-specific signal and is the one that matters here; the
// display-mode query is the standard one, kept for anything else that installs the app.
export const isStandaloneWebApp = (): boolean => {
    if (typeof navigator !== 'undefined' && (navigator as any).standalone === true) return true;
    try {
        return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
    } catch (_) {
        return false;
    }
};

export const isPictureInPictureSupported = (video: HTMLVideoElement | null): boolean => {
    const supports = video && (video as any).webkitSupportsPresentationMode;
    if (typeof supports !== 'function') return false;
    try {
        return supports.call(video, 'picture-in-picture') === true;
    } catch (_) {
        return false;
    }
};

const currentMode = (video: HTMLVideoElement | null): string => {
    if (!video) return 'no-element';
    const mode = (video as any).webkitPresentationMode;
    return typeof mode === 'string' ? mode : 'unknown';
};

const save = (record: Record): void => {
    try {
        localStorage.setItem(KEY, JSON.stringify(record));
    } catch (_) {
        // A diagnostic must never break playback.
    }
};

export const recordPictureInPicture = (video: HTMLVideoElement | null, why: string, err?: string): void => {
    save({
        at: Date.now(),
        why,
        supported: isPictureInPictureSupported(video),
        standalone: isStandaloneWebApp(),
        mode: currentMode(video),
        err,
    });
};

// Enter or leave Picture-in-Picture. MUST be called from inside a user gesture: WebKit
// refuses a presentation-mode change made outside one, the same lesson the audio session
// write taught us. Any refusal is recorded rather than thrown - including the
// "does not support the Picture-in-Picture mode" exception a standalone web app is expected
// to produce, which is precisely the evidence worth having.
export const togglePictureInPicture = (video: HTMLVideoElement | null): void => {
    if (!video) return;

    const setMode = (video as any).webkitSetPresentationMode;
    if (typeof setMode !== 'function') {
        recordPictureInPicture(video, 'tap', 'no-webkitSetPresentationMode');
        return;
    }

    const target = currentMode(video) === 'picture-in-picture' ? 'inline' : 'picture-in-picture';
    try {
        setMode.call(video, target);
        recordPictureInPicture(video, 'tap:' + target);
    } catch (error) {
        recordPictureInPicture(video, 'tap:' + target, String((error as Error)?.message || error));
    }
};

const ago = (at: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
};

export const pictureInPictureReport = (): string => {
    let record: Record | null = null;
    try {
        const raw = localStorage.getItem(KEY);
        record = raw ? JSON.parse(raw) as Record : null;
    } catch (_) {
        record = null;
    }

    if (!record) return 'never checked';
    return 'supported=' + record.supported +
        ' standalone=' + record.standalone +
        ' mode=' + record.mode +
        (record.err ? ' ERR:' + record.err : '') +
        ' (' + record.why + ', ' + ago(record.at) + ')';
};
