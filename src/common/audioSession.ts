// HomeIomp: the one place that writes navigator.audioSession.type, and the record of what
// happened when it did.
//
// Why a record at all: the phone this matters on has no developer console, so the only way
// to learn whether a write landed is to have the app remember and show it. The record is
// kept in localStorage rather than memory because the reading has to survive the document
// being torn down - an iOS home screen web app or a backgrounded Safari tab is reloaded
// constantly, and `navigator.audioSession.type` is per-document page state (WebKit's
// DOMAudioSession::type() reads Page::audioSessionType(), which only DOMAudioSession::setType
// ever writes). A fresh document therefore reads 'auto' no matter how well the write worked
// in the previous one, which is a trap for anyone reading the value alone.

const WRITE_KEY = 'homeiomp.audioSession.lastWrite';
const FULLSCREEN_KEY = 'homeiomp.audioSession.lastFullscreen';

type WriteRecord = {
    at: number,
    why: string,
    before: string,
    after: string,
    err?: string,
};

type FullscreenRecord = {
    at: number,
    event: string,
    type: string,
    muted: string,
    volume: string,
    displaying: string,
};

const supported = (): boolean => typeof navigator !== 'undefined' && 'audioSession' in navigator;

export const readAudioSessionType = (): string => {
    if (!supported()) return 'unsupported';
    try {
        return String((navigator as any).audioSession?.type ?? 'unknown');
    } catch (_) {
        return 'read-error';
    }
};

const load = <T>(key: string): T | null => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as T : null;
    } catch (_) {
        return null;
    }
};

const save = (key: string, value: unknown): void => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
        // Private mode, quota, whatever - a diagnostic must never break playback.
    }
};

// Set the page's audio session to 'playback' - the category that is NOT silenced by the
// Ring/Silent switch and that may keep playing in the background (which is what
// Picture-in-Picture needs). Safe to call as often as we like: it writes only when the value
// is not already right, and it never throws.
export const assertPlaybackAudioSession = (why: string): void => {
    if (!supported()) return;

    const before = readAudioSessionType();
    if (before === 'playback') {
        // Still worth recording once, so "it was already right" is distinguishable from
        // "nothing ever tried".
        const previous = load<WriteRecord>(WRITE_KEY);
        if (!previous || previous.after !== 'playback') {
            save(WRITE_KEY, { at: Date.now(), why, before, after: 'playback' } as WriteRecord);
        }
        return;
    }

    let err: string | undefined;
    try {
        (navigator as any).audioSession.type = 'playback';
    } catch (error) {
        err = String((error as Error)?.name || error);
    }

    const record: WriteRecord = { at: Date.now(), why, before, after: readAudioSessionType(), err };
    const previous = load<WriteRecord>(WRITE_KEY);
    // Taps are frequent; only persist when the OUTCOME changes, or the first time.
    if (!previous || previous.after !== record.after || previous.err !== record.err) {
        save(WRITE_KEY, record);
    }
};

// Snapshot the element state at a fullscreen / presentation-mode transition. This is the
// moment the sound is reported to die, and it is the one moment nobody can inspect from a
// phone: whether the element went muted, whether its volume was zeroed, and what the audio
// session type actually was right then.
export const recordFullscreenTransition = (event: string, target: EventTarget | null): void => {
    const element = target as HTMLVideoElement | null;
    save(FULLSCREEN_KEY, {
        at: Date.now(),
        event,
        type: readAudioSessionType(),
        muted: element && typeof element.muted === 'boolean' ? String(element.muted) : '?',
        volume: element && typeof element.volume === 'number' ? String(element.volume) : '?',
        displaying: element && typeof (element as any).webkitDisplayingFullscreen === 'boolean' ?
            String((element as any).webkitDisplayingFullscreen)
            :
            '?',
    } as FullscreenRecord);
};

const ago = (at: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
};

export const audioSessionWriteReport = (): string => {
    const record = load<WriteRecord>(WRITE_KEY);
    if (!record) return 'never written';
    return record.before + '→' + record.after +
        (record.err ? ' ERR:' + record.err : '') +
        ' (' + record.why + ', ' + ago(record.at) + ')';
};

export const fullscreenReport = (): string => {
    const record = load<FullscreenRecord>(FULLSCREEN_KEY);
    if (!record) return 'none seen';
    return record.event + ' type=' + record.type + ' muted=' + record.muted +
        ' vol=' + record.volume + ' fs=' + record.displaying + ' (' + ago(record.at) + ')';
};
