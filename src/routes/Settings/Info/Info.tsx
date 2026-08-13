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
    }), [tick]);

    // Tapping the line performs the write from inside a real user gesture - the one context
    // WebKit may treat differently from a write made during a React effect - and shows what
    // came back. Tap it, and the value to the left is what WebKit accepted.
    const onAudioSessionClick = useCallback(() => {
        assertPlaybackAudioSession('settings-tap');
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
