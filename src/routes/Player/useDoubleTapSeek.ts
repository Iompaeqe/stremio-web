// HomeIomp: double-tap the left or right of the video to seek, the way every phone video
// player does it. Touch only - it hangs off touchend, which a mouse never fires, so the
// existing click and double-click behaviour (double-click toggles fullscreen) is untouched.
//
// Layout: the outer thirds seek, the middle third is left alone - that is where a tap should
// still just bring the controls up, and it keeps a mistimed tap near the centre harmless.
//
// Chaining works like YouTube's: the first DOUBLE tap on a side jumps one step and opens a
// short window, and each further SINGLE tap on that same side inside the window adds another
// step (10, 20, 30...). Chained taps accumulate against the chain's own target rather than
// against video.state.time, which only catches up on the next timeupdate and would otherwise
// make three fast taps land on +10 twice.
//
// The seek itself goes through the player's ordinary onSeekRequested - the same path the
// seek bar and the keyboard shortcuts use - so nothing about buffering or the native-HLS iOS
// path is special-cased here.
//
// THE LISTENER IS NATIVE, ON THE VIDEO CONTAINER, AND NOT PASSIVE, and all three matter.
// React delegates events to the application root, so a single ancestor calling
// stopPropagation on touchend anywhere between the video and the root would silently kill a
// React onTouchEnd and leave no trace; a listener on the container itself runs before any
// ancestor can interfere. Non-passive is what makes preventDefault() actually suppress the
// synthesised click pair, which is how a seek avoids also toggling fullscreen. The container
// is the video layer only - the control bar and nav bar are sibling layers on top of it, so
// tapping a button is not on this element's path and can never be read as a seek.

import { useCallback, useEffect, useRef, useState } from 'react';
import { recordTap } from 'stremio/common/tapDiagnostics';
import type { SeekFeedback } from './SeekIndicator/SeekIndicator';

// A second tap later than this is a new first tap, not a double tap.
const DOUBLE_TAP_MS = 320;
// How long after a seek a single tap on the same side keeps adding to it.
const CHAIN_MS = 900;
// How long the flash stays up. Slightly longer than the chain window so the indicator is
// still on screen while it can still be added to.
const FEEDBACK_MS = 1000;
// A tap that lands this far from the previous one is a new gesture, not the second half of a
// double tap - it was a swipe, or the other hand.
const TAP_SLOP_PX = 80;
// Ignore taps in the middle third.
const EDGE_FRACTION = 1 / 3;

type Side = 'backward' | 'forward';

type Args = {
    // The video layer. Taps are measured against it and the listener lives on it.
    element: HTMLElement | null,
    time: number | null,
    duration: number | null,
    // Milliseconds per step; the player passes the same setting the arrow keys use.
    step: number,
    onSeekRequested: (time: number) => void,
    onSeekStarted: () => void,
};

const useDoubleTapSeek = ({ element, time, duration, step, onSeekRequested, onSeekStarted }: Args) => {
    const [feedback, setFeedback] = useState<SeekFeedback | null>(null);

    // Everything the handler needs is read through a ref: the listener is attached once per
    // element, and reading live values this way keeps it from being torn down and rebuilt on
    // every timeupdate.
    const latest = useRef({ time, duration, step, onSeekRequested, onSeekStarted });
    latest.current = { time, duration, step, onSeekRequested, onSeekStarted };

    const lastTap = useRef<{ at: number, x: number, y: number, side: Side | null }>({ at: 0, x: 0, y: 0, side: null });
    const chain = useRef<{ side: Side | null, target: number, seconds: number, until: number }>({ side: null, target: 0, seconds: 0, until: 0 });
    const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const feedbackId = useRef(0);
    // Set when a tap has been consumed as a seek, so the player can ignore the double-click
    // that the browser may synthesise from the same gesture and not toggle fullscreen.
    const consumedUntil = useRef(0);

    const seekConsumed = useCallback(() => Date.now() < consumedUntil.current, []);

    useEffect(() => {
        if (!element) return;

        const onTouchEnd = (event: TouchEvent) => {
            const { time: currentTime, duration: totalTime, step: stepMs, onSeekRequested: seek, onSeekStarted: startSeeking } = latest.current;

            const touch = event.changedTouches && event.changedTouches[0];
            if (!touch || event.touches.length > 0) {
                recordTap('-', 'ignored:multitouch');
                return;
            }

            const rect = element.getBoundingClientRect();
            if (rect.width === 0) {
                recordTap('-', 'ignored:no-rect');
                return;
            }

            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;
            const now = Date.now();

            const side: Side | null =
                x < rect.width * EDGE_FRACTION ? 'backward' :
                    x > rect.width * (1 - EDGE_FRACTION) ? 'forward' :
                        null;
            const zone = side === 'backward' ? 'left' : side === 'forward' ? 'right' : 'middle';

            if (side === null) {
                // Middle third: cancel any chain and let the tap through untouched.
                chain.current.side = null;
                lastTap.current = { at: now, x, y, side: null };
                recordTap(zone, 'middle');
                return;
            }

            // A seek needs to know where it is starting from. Duration is only used to clamp,
            // and is not required: a stream that reports no duration can still be seeked
            // backwards, and forwards past the end simply lands at the end.
            if (currentTime === null) {
                recordTap(zone, 'ignored:no-time');
                return;
            }

            const chained = chain.current.side === side && now < chain.current.until;
            const sinceLast = now - lastTap.current.at;
            const doubled = lastTap.current.side === side &&
                sinceLast < DOUBLE_TAP_MS &&
                Math.abs(x - lastTap.current.x) < TAP_SLOP_PX &&
                Math.abs(y - lastTap.current.y) < TAP_SLOP_PX;

            if (!chained && !doubled) {
                // First tap of a possible double tap. Nothing happens yet, and the tap keeps
                // its ordinary effect of waking the controls.
                lastTap.current = { at: now, x, y, side };
                recordTap(zone, 'first');
                return;
            }

            const upperBound = totalTime !== null && isFinite(totalTime) && totalTime > 0 ? totalTime : Infinity;
            const base = chained ? chain.current.target : currentTime;
            const delta = side === 'forward' ? stepMs : -stepMs;
            const target = Math.max(0, Math.min(upperBound, base + delta));
            const seconds = (chained ? chain.current.seconds : 0) + Math.round(stepMs / 1000);

            chain.current = { side, target, seconds, until: now + CHAIN_MS };
            lastTap.current = { at: 0, x, y, side };

            startSeeking();
            seek(target);

            feedbackId.current += 1;
            setFeedback({ side, seconds, id: feedbackId.current });
            if (hideTimeout.current) clearTimeout(hideTimeout.current);
            hideTimeout.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);

            // Stop the browser turning this tap into click/dblclick: without it the same
            // gesture would also toggle fullscreen. consumedUntil covers the browsers that
            // synthesise the click anyway.
            if (event.cancelable) event.preventDefault();
            consumedUntil.current = now + 700;

            recordTap(zone, chained ? 'chain' : 'double', (side === 'forward' ? '+' : '-') + seconds + 's');
        };

        element.addEventListener('touchend', onTouchEnd, { passive: false });
        return () => element.removeEventListener('touchend', onTouchEnd);
    }, [element]);

    useEffect(() => () => {
        if (hideTimeout.current) clearTimeout(hideTimeout.current);
    }, []);

    return { feedback, seekConsumed };
};

export default useDoubleTapSeek;
