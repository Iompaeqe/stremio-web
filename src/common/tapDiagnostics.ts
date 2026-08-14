// HomeIomp: what the player's double-tap seek gesture saw, kept so a phone with no developer
// console can report it. Same pattern as the audio session and Picture-in-Picture records:
// written by the player, read by Settings, in localStorage so it survives the document being
// reloaded (which iOS does to home screen web apps constantly).
//
// The count is the important half. "Taps: 0" means the handler is never reaching the finger
// at all, which is a completely different bug from "every tap is classified as a first tap",
// which is a timing or geometry problem.

const KEY = 'homeiomp.tap.last';

type TapRecord = {
    at: number,
    taps: number,
    zone: string,
    result: string,
    detail?: string,
};

const load = (): TapRecord | null => {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) as TapRecord : null;
    } catch (_) {
        return null;
    }
};

export const recordTap = (zone: string, result: string, detail?: string): void => {
    try {
        const previous = load();
        const record: TapRecord = {
            at: Date.now(),
            taps: (previous?.taps ?? 0) + 1,
            zone,
            result,
            detail,
        };
        localStorage.setItem(KEY, JSON.stringify(record));
    } catch (_) {
        // A diagnostic must never break playback.
    }
};

const ago = (at: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
};

export const tapReport = (): string => {
    const record = load();
    if (!record) return 'no taps seen';
    return 'taps=' + record.taps +
        ' last=' + record.zone + ' ' + record.result +
        (record.detail ? ' ' + record.detail : '') +
        ' (' + ago(record.at) + ')';
};
