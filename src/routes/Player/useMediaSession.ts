import { useEffect } from 'react';
import { usePlatform } from 'stremio/common';
import { assertPlaybackAudioSession, recordFullscreenTransition } from 'stremio/common/audioSession';

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
    // The type is asserted on mount - before the element exists, so before the first play()
    // and long before any fullscreen transition, which is the order WebKit wants - then
    // re-asserted on the media events that could disturb it, and again on the first pointer
    // event, which is the one context that is unambiguously a USER GESTURE. Some WebKit
    // capabilities are only granted inside one, and an assertion that costs nothing is
    // cheaper than another round trip to find out. assertPlaybackAudioSession writes only
    // when the value is not already right and never throws.
    //
    // Media events are listened for on document in the CAPTURE phase: none of them bubble,
    // but capture still reaches them on the way down to the element, which also means this
    // hook needs no handle on the video element that @stremio/stremio-video creates for
    // itself. The fullscreen ones additionally snapshot that element's state (muted, volume,
    // the session type at that instant) into the diagnostic, because the transition is
    // exactly the moment the sound is reported to die and exactly the moment nobody can
    // inspect from a phone.
    useEffect(() => {
        const mediaEvents = ['loadedmetadata', 'play', 'playing'];
        const fullscreenEvents = ['webkitbeginfullscreen', 'webkitendfullscreen', 'webkitpresentationmodechanged', 'fullscreenchange'];
        const gestureEvents = ['pointerdown', 'touchend'];

        const onMediaEvent = (event: Event) => assertPlaybackAudioSession('media:' + event.type);
        const onGesture = (event: Event) => assertPlaybackAudioSession('gesture:' + event.type);
        const onFullscreenEvent = (event: Event) => {
            // Assert FIRST, then record, so the snapshot shows what the player left behind.
            assertPlaybackAudioSession('fs:' + event.type);
            recordFullscreenTransition(event.type, event.target);
        };

        assertPlaybackAudioSession('player-mount');
        mediaEvents.forEach((event) => document.addEventListener(event, onMediaEvent, true));
        fullscreenEvents.forEach((event) => document.addEventListener(event, onFullscreenEvent, true));
        gestureEvents.forEach((event) => document.addEventListener(event, onGesture, true));
        return () => {
            mediaEvents.forEach((event) => document.removeEventListener(event, onMediaEvent, true));
            fullscreenEvents.forEach((event) => document.removeEventListener(event, onFullscreenEvent, true));
            gestureEvents.forEach((event) => document.removeEventListener(event, onGesture, true));
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
