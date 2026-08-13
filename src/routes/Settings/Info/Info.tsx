import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlatform } from 'stremio/common';
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

    // Read on every render (this panel is cheap and only rendered in Settings) so the value
    // is the live one, not one captured when the app booted.
    const audioSessionType = 'audioSession' in navigator ?
        String((navigator as any).audioSession?.type ?? 'unknown')
        :
        'unsupported';

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
                than in a debug overlay: an iPhone has no developer console, so this line is
                the only way its owner can answer "does this device even have the WebKit
                audio session API, and what is it set to" — the question the fullscreen
                sound fix turns on. 'playback' is what the player asserts and holds;
                'unsupported' would mean the fix cannot be the whole story on this device.
            */}
            <Option label={'Audio session'}>
                <div className={styles['label']}>
                    {audioSessionType}
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
