import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlatform } from 'stremio/common';
import {
    assertPlaybackAudioSession,
    audioSessionWriteReport,
    fullscreenReport,
    readAudioSessionType,
} from 'stremio/common/audioSession';
import { pictureInPictureReport } from 'stremio/common/pictureInPicture';
import {
    ensureStreamingDoor,
    isHevcPassthroughEnabled,
    isLanDoorEnabled,
    playbackPathReport,
    setHevcPassthroughEnabled,
    setLanDoorEnabled,
    streamingDoorReport,
} from 'stremio/common/streamingDoor';
import { tapReport } from 'stremio/common/tapDiagnostics';
import { wakeLockReport } from 'stremio/common/wakeLock';
import { Option, Section } from '../components';
import styles from './Info.less';

type Props = {
    streamingServer: StreamingServer,
};

const Info = ({ streamingServer }: Props) => {
    const { shell } = usePlatform();
    const { t } = useTranslation();

    const settings = useMemo(() => (
        streamingServer?.settings?.type === 'Ready' ?
            streamingServer.settings.content as StreamingServerSettings : null
    ), [streamingServer?.settings]);

    // HomeIomp diagnostic. `tick` exists only to re-read the values after the line is
    // tapped; the reads themselves are trivial.
    const [tick, setTick] = useState(0);
    const audioSession = useMemo(() => ({
        type: readAudioSessionType(),
        write: audioSessionWriteReport(),
        fullscreen: fullscreenReport(),
        pictureInPicture: pictureInPictureReport(),
        tap: tapReport(),
    }), [tick]);

    // Tapping the line performs the write from inside a real user gesture - the one context
    // WebKit may treat differently from a write made during a React effect - and shows what
    // came back. Tap it, and the value to the left is what WebKit accepted.
    const onAudioSessionClick = useCallback(() => {
        assertPlaybackAudioSession('settings-tap');
        setTick((value) => value + 1);
    }, []);

    // The streaming server this device is configured for, before the LAN door is considered.
    const configuredServerURL = useMemo(() => (
        streamingServer?.selected?.transportUrl ?? streamingServer?.baseUrl ?? null
    ), [streamingServer?.selected, streamingServer?.baseUrl]);

    const playback = useMemo(() => ({
        path: playbackPathReport(),
        door: streamingDoorReport(configuredServerURL),
        lan: isLanDoorEnabled(),
        hevc: isHevcPassthroughEnabled(),
        wakeLock: wakeLockReport(),
    }), [tick, configuredServerURL]);

    // Tapping the door line re-runs the probe, which is exactly what the owner wants to do when
    // he has just walked in the door and wants to know whether the phone can see the LAN.
    const onDoorClick = useCallback(() => {
        ensureStreamingDoor(configuredServerURL).then(() => setTick((value) => value + 1));
        setTick((value) => value + 1);
    }, [configuredServerURL]);

    // Both switches are tap-to-toggle, so a build that misbehaves on this phone can be put back
    // on the old path from the sofa instead of from a rebuild.
    const onLanDoorClick = useCallback(() => {
        setLanDoorEnabled(!isLanDoorEnabled());
        setTick((value) => value + 1);
    }, []);

    const onHevcClick = useCallback(() => {
        setHevcPassthroughEnabled(!isHevcPassthroughEnabled());
        setTick((value) => value + 1);
    }, []);

    return (
        <Section className={styles['info']}>
            <Option label={t('SETTINGS_APP_VERSION')}>
                <div className={styles['label']}>
                    {process.env.VERSION}
                </div>
            </Option>
            <Option label={t('SETTINGS_BUILD_VERSION')}>
                <div className={styles['label']}>
                    {process.env.COMMIT_HASH}
                </div>
            </Option>
            {/*
                HomeIomp diagnostic, deliberately untranslated and deliberately here rather
                than in a debug overlay: an iPhone has no developer console, so these lines
                are the only way its owner can report what the audio session actually did.

                "Audio session" is the LIVE type for this document, and it resets to 'auto'
                whenever the document is torn down and reloaded - which iOS does to
                backgrounded tabs and home screen web apps constantly - so on its own it says
                nothing about whether the player's write worked. Tap it to write from inside
                a real user gesture and see the result immediately.

                "Audio session write" is the last write the player attempted, kept in
                localStorage so it survives those reloads: before→after, why, and how long
                ago. after=playback means the write lands; after=auto means WebKit refused it.

                "Last fullscreen" is the element's state at the last fullscreen transition -
                the moment the sound is reported to die, and the one moment that cannot be
                inspected from a phone.
            */}
            <Option label={'Audio session'}>
                <div className={styles['label']} onClick={onAudioSessionClick}>
                    {audioSession.type}
                </div>
            </Option>
            <Option label={'Audio session write'}>
                <div className={styles['label']}>
                    {audioSession.write}
                </div>
            </Option>
            <Option label={'Last fullscreen'}>
                <div className={styles['label']}>
                    {audioSession.fullscreen}
                </div>
            </Option>
            {/*
                "Picture in Picture" is what the platform said the last time the player asked
                or the button was tapped: whether WebKit offers the presentation mode at all,
                whether this is a standalone home screen app (the case Apple restricts), the
                current presentation mode, and the refusal message if there was one.
            */}
            <Option label={'Picture in Picture'}>
                <div className={styles['label']}>
                    {audioSession.pictureInPicture}
                </div>
            </Option>
            {/*
                "Player taps" is what the double-tap seek gesture saw. The count is the
                important half: taps=0 means the handler never reached the finger at all,
                which is a different bug entirely from every tap being classified 'first',
                which would be a timing or geometry problem.
            */}
            <Option label={'Player taps'}>
                <div className={styles['label']}>
                    {audioSession.tap}
                </div>
            </Option>
            {/*
                "Playback path" is which stack decodes the stream on this device: WebKit's own HLS
                (every iPhone) or hls.js over MediaSource (every desktop browser). It decides
                nothing about URLs any more - those are correct on both - but it is the first thing
                worth knowing when playback behaves differently here than on the PC.

                "Streaming server" is the base URL playback actually builds its requests on, which
                is not necessarily the one in Settings: at home the LAN door is used instead of the
                tunnel. It says which, and how long ago that was established. Tap it to probe again
                (do that after walking in the front door); tap "LAN door" to stop using it at all.

                "HEVC passthrough" asks the server to hand x265 releases to this phone untouched
                rather than re-encoding them to H.264. Tap it off if some release plays badly.
            */}
            <Option label={'Playback path'}>
                <div className={styles['label']}>
                    {playback.path}
                </div>
            </Option>
            <Option label={'Streaming server'}>
                <div className={styles['label']} onClick={onDoorClick}>
                    {playback.door}
                </div>
            </Option>
            <Option label={'LAN door'}>
                <div className={styles['label']} onClick={onLanDoorClick}>
                    {playback.lan ? 'on (tap to turn off)' : 'off (tap to turn on)'}
                </div>
            </Option>
            <Option label={'HEVC passthrough'}>
                <div className={styles['label']} onClick={onHevcClick}>
                    {playback.hevc ? 'on (tap to turn off)' : 'off — needs hvc1 on the server (tap to try)'}
                </div>
            </Option>
            <Option label={'Screen wake lock'}>
                <div className={styles['label']}>
                    {playback.wakeLock}
                </div>
            </Option>
            {
                settings?.serverVersion &&
                    <Option label={t('SETTINGS_SERVER_VERSION')}>
                        <div className={styles['label']}>
                            {settings.serverVersion}
                        </div>
                    </Option>
            }
            {
                typeof shell.state.version === 'string' &&
                    <Option label={t('SETTINGS_SHELL_VERSION')}>
                        <div className={styles['label']}>
                            {shell.state.version}
                        </div>
                    </Option>
            }
        </Section>
    );
};

export default Info;
