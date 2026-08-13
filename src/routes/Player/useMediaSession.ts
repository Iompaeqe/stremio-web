import { useEffect } from 'react';
import { usePlatform } from 'stremio/common';

const useMediaSession = (
    videoState: VideoState,
    player: Player,
    fullscreen: boolean,
    onPlayRequested: () => void,
    onPauseRequested: () => void,
    onNextVideoRequested: () => void,
) => {
    const { shell } = usePlatform();

    // HomeIomp: the audio session stays on 'playback' for the whole life of the player,
    // fullscreen included. Upstream downgrades it to 'ambient' while `fullscreen` is true
    // (671170a9, "feat: fullscreen support on safari") and that is what kills the sound on
    // an iPhone:
    //
    //   * 'ambient' maps to AVAudioSessionCategoryAmbient in WebKit — audio silenced by the
    //     hardware Ring/Silent switch, silenced by screen lock, and not allowed to keep
    //     playing while Safari is in the background.
    //   * On iPhone the player has no Fullscreen API, so FullscreenProvider goes through
    //     videoElement.webkitEnterFullscreen(); `webkitbeginfullscreen` (which also fires
    //     when fullscreen is entered from iOS's own video controls) flips `fullscreen` to
    //     true, this effect runs, and playback goes mute for anyone with the ringer switch
    //     on silent — exactly the state the phone spends most of its life in.
    //   * Picture-in-Picture is entered from that same native fullscreen UI and needs a
    //     background-capable session, which 'ambient' is not.
    //
    // 'playback' is the correct category for a video player and is what the platform picks
    // for one anyway, so nothing is lost by holding it. `fullscreen` stays in the signature:
    // the hook is fullscreen-aware for other reasons and callers pass it positionally.
    //
    // The type is asserted once on mount - before the element exists, so before the first
    // play() and long before any fullscreen transition, which is the order WebKit wants -
    // and then re-asserted on the media events that could plausibly disturb it. Nothing
    // else in this app or in @stremio/stremio-video writes navigator.audioSession (checked
    // across src/ and node_modules/), so the re-assert is belt and braces rather than a
    // known fight; it is guarded on the current value, so in the normal case it writes
    // nothing at all. Listeners are on document in the CAPTURE phase because none of these
    // events bubble - capture still reaches them on the way down to the element - which
    // also means this does not need a reference to the video element that
    // @stremio/stremio-video creates for itself.
    useEffect(() => {
        if (!('audioSession' in navigator)) return;
        const audioSession = (navigator as any).audioSession;
        const assertPlayback = () => {
            if (audioSession.type !== 'playback') {
                audioSession.type = 'playback';
            }
        };
        const events = [
            'webkitbeginfullscreen',
            'webkitendfullscreen',
            'webkitpresentationmodechanged',
            'loadedmetadata',
            'play',
            'playing',
        ];

        assertPlayback();
        events.forEach((event) => document.addEventListener(event, assertPlayback, true));
        return () => {
            events.forEach((event) => document.removeEventListener(event, assertPlayback, true));
        };
    }, []);

    // Playback state
    useEffect(() => {
        if (navigator.mediaSession) {
            const playbackState = videoState.paused === null ? 'none' : videoState.paused ? 'paused' : 'playing';
            navigator.mediaSession.playbackState = playbackState;
        }

        if (shell.active) {
            shell.send('media.status', {
                paused: !!videoState.paused,
            });
        }

        return () => {
            if (navigator.mediaSession) {
                navigator.mediaSession.playbackState = 'none';
            }
        };
    }, [videoState.paused]);

    // Metadata
    useEffect(() => {
        const metaItem = player.metaItem && player.metaItem?.type === 'Ready' ? player.metaItem.content as MetaItemPlayer : null;
        const videoId = player.selected ? player.selected?.streamRequest?.path?.id : null;
        const video = metaItem?.videos.find(({ id }) => id === videoId);

        const videoInfo = video?.season && video?.episode ? ` (${video.season}x${video.episode})` : null;
        const videoTitle = video ? `${video.title}${videoInfo}` : null;
        const metaTitle = metaItem ? metaItem.name : null;
        const imageUrl = metaItem ? metaItem.logo : null;

        const title = videoTitle ?? metaTitle;
        const artist = (videoTitle && metaTitle) ?? undefined;
        const artwork = imageUrl ? [{ src: imageUrl }] : undefined;

        if (title) {
            if (navigator.mediaSession) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title,
                    artist,
                    artwork,
                });
            }

            if (shell.active) {
                shell.send('media.metadata', {
                    title,
                    artist,
                    artUrl: imageUrl,
                });
            }
        }
    }, [player.metaItem, player.selected]);

    // Callbacks
    useEffect(() => {
        if (navigator.mediaSession) {
            navigator.mediaSession.setActionHandler('play', videoState.paused === true ? onPlayRequested : null);
            navigator.mediaSession.setActionHandler('pause', videoState.paused === false ? onPauseRequested : null);
        }

        const nexVideoCallback = player.nextVideo ? onNextVideoRequested : null;
        if (navigator.mediaSession && nexVideoCallback) {
            navigator.mediaSession.setActionHandler('nexttrack', nexVideoCallback);
        }

        const onMediaStatus = ({ paused }: MediaStatus) => {
            paused ? onPauseRequested() : onPlayRequested();
        };

        shell.on('media.status', onMediaStatus);

        return () => {
            navigator.mediaSession.setActionHandler('play', null);
            navigator.mediaSession.setActionHandler('pause', null);
            navigator.mediaSession.setActionHandler('nexttrack', null);
            shell.off('media.status', onMediaStatus);
        };
    }, [videoState.paused, player.nextVideo, onPlayRequested, onPauseRequested, onNextVideoRequested]);
};

export default useMediaSession;
