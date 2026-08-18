// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { t } = require('i18next');
const { useCore } = require('stremio/core');
const { useProfile, usePlatform, useToast, useBinaryState, isHomeIompApp, postToApp, downloadItemId, buildDownloadPayload, useDownloadState, subtitleAddons, fetchEnglishSubtitles } = require('stremio/common');
const { Button, Image, Popup } = require('stremio/components');
const { useRouteFocused } = require('stremio-router');
const StreamPlaceholder = require('./StreamPlaceholder');
const styles = require('./styles');

// HomeIomp: labels for the app-only download actions. They are constants rather than
// translation keys on purpose - they never reach a browser, and the upstream translation
// bundle this fork pulls in has no key to carry them.
const DOWNLOAD_LABEL = 'Download';
const DOWNLOAD_SEASON_LABEL = 'Download season';

const Stream = ({ className, videoId, videoReleased, addonName, name, description, thumbnail, progress, deepLinks, stream, addon, meta, video, canDownloadSeason, ...props }) => {
    const profile = useProfile();
    const toast = useToast();
    const platform = usePlatform();
    const core = useCore();
    const routeFocused = useRouteFocused();

    const [menuOpen, , closeMenu, toggleMenu] = useBinaryState(false);

    const popupLabelOnMouseUp = React.useCallback((event) => {
        if (!event.nativeEvent.togglePopupPrevented) {
            if (event.nativeEvent.ctrlKey || event.nativeEvent.button === 2) {
                event.preventDefault();
                toggleMenu();
            }
        }
    }, []);
    const popupLabelOnContextMenu = React.useCallback((event) => {
        if (!event.nativeEvent.togglePopupPrevented && !event.nativeEvent.ctrlKey) {
            event.preventDefault();
        }
    }, [toggleMenu]);
    const popupLabelOnLongPress = React.useCallback((event) => {
        if (event.nativeEvent.pointerType !== 'mouse' && !event.nativeEvent.togglePopupPrevented) {
            toggleMenu();
        }
    }, [toggleMenu]);
    const popupMenuOnPointerDown = React.useCallback((event) => {
        event.nativeEvent.togglePopupPrevented = true;
    }, []);
    const popupMenuOnContextMenu = React.useCallback((event) => {
        event.nativeEvent.togglePopupPrevented = true;
    }, []);
    const popupMenuOnClick = React.useCallback((event) => {
        event.nativeEvent.togglePopupPrevented = true;
    }, []);
    const popupMenuOnKeyDown = React.useCallback((event) => {
        event.nativeEvent.buttonClickPrevented = true;
    }, []);

    const href = React.useMemo(() => {
        return deepLinks ?
            deepLinks.externalPlayer ?
                deepLinks.externalPlayer.web ?
                    deepLinks.externalPlayer.web
                    :
                    deepLinks.externalPlayer.openPlayer ?
                        deepLinks.externalPlayer.openPlayer[platform.name] ?
                            deepLinks.externalPlayer.openPlayer[platform.name]
                            :
                            deepLinks.externalPlayer.playlist
                        :
                        deepLinks.player
                :
                deepLinks.player
            :
            null;
    }, [deepLinks]);

    const download = React.useMemo(() => {
        return href === deepLinks?.externalPlayer?.playlist ?
            deepLinks.externalPlayer.fileName
            :
            null;
    }, [href, deepLinks]);

    const target = React.useMemo(() => {
        return href === deepLinks?.externalPlayer?.web ?
            '_blank'
            :
            null;
    }, [href, deepLinks]);

    const streamLink = React.useMemo(() => {
        return deepLinks?.externalPlayer?.streaming;
    }, [deepLinks]);

    const downloadLink = React.useMemo(() => {
        return deepLinks?.externalPlayer?.download;
    }, [deepLinks]);

    const magnetLink = React.useMemo(() => {
        return deepLinks?.externalPlayer?.magnet;
    }, [deepLinks]);

    const markVideoAsWatched = React.useCallback(() => {
        if (typeof videoId === 'string') {
            core.transport.dispatch({
                action: 'MetaDetails',
                args: {
                    action: 'MarkVideoAsWatched',
                    args: [{ id: videoId, released: videoReleased }, true]
                }
            });
        }
    }, [videoId, videoReleased]);

    const onClick = React.useCallback((event) => {
        if (event.nativeEvent.togglePopupPrevented) {
            return;
        }

        if (profile.settings.playerType !== null) {
            markVideoAsWatched();
            toast.show({
                type: 'success',
                title: 'Stream opened in external player',
                timeout: 4000
            });
        }

        if (typeof props.onClick === 'function') {
            props.onClick(event);
        }
    }, [props.onClick, profile.settings, markVideoAsWatched]);

    const copyMagnetLink = React.useCallback((event) => {
        event.preventDefault();
        closeMenu();
        if (magnetLink) {
            navigator.clipboard.writeText(magnetLink)
                .then(() => {
                    toast.show({
                        type: 'success',
                        title: t('PLAYER_COPY_MAGNET_LINK_SUCCESS'),
                        timeout: 4000
                    });
                })
                .catch(() => {
                    toast.show({
                        type: 'error',
                        title: t('PLAYER_COPY_MAGNET_LINK_ERROR'),
                        timeout: 4000,
                    });
                });
        }
    }, [magnetLink]);

    const copyDownloadLink = React.useCallback((event) => {
        event.preventDefault();
        closeMenu();
        if (downloadLink) {
            navigator.clipboard.writeText(downloadLink)
                .then(() => {
                    toast.show({
                        type: 'success',
                        title: t('PLAYER_COPY_DOWNLOAD_LINK_SUCCESS'),
                        timeout: 4000
                    });
                })
                .catch(() => {
                    toast.show({
                        type: 'error',
                        title: t('PLAYER_COPY_DOWNLOAD_LINK_ERROR'),
                        timeout: 4000,
                    });
                });
        }
    }, [downloadLink]);

    const copyStreamLink = React.useCallback((event) => {
        event.preventDefault();
        closeMenu();
        if (streamLink) {
            navigator.clipboard.writeText(streamLink)
                .then(() => {
                    toast.show({
                        type: 'success',
                        title: t('PLAYER_COPY_STREAM_SUCCESS'),
                        timeout: 4000
                    });
                })
                .catch(() => {
                    toast.show({
                        type: 'error',
                        title: t('PLAYER_COPY_STREAM_ERROR'),
                        timeout: 4000,
                    });
                });
        }
    }, [streamLink]);

    /*
        HomeIomp: the download bridge. isHomeIompApp() is false in every browser we ship to,
        so everything below collapses to null there and the row stays byte-identical - the
        actions exist only inside the native iOS app, which is the only thing that can hold a
        downloaded file. The row posts what it knows (meta, video, stream, addon) and lets the
        app decide what to do with it; a stream with no infoHash is posted all the same.
    */
    const inApp = React.useMemo(() => isHomeIompApp(), []);
    const downloadId = React.useMemo(() => (
        inApp && stream ? downloadItemId(video?.id ?? videoId ?? meta?.id, stream) : null
    ), [inApp, stream, video, videoId, meta]);
    const downloadState = useDownloadState(downloadId);
    const downloadStateLabel = React.useMemo(() => {
        if (downloadState === null) return null;
        if (downloadState.state === 'done') return 'Downloaded';
        if (typeof downloadState.progress === 'number') return Math.round(downloadState.progress) + '%';
        return downloadState.state;
    }, [downloadState]);
    const downloadIconName = React.useMemo(() => {
        if (downloadState?.state === 'done') return 'checkmark';
        if (downloadState?.state === 'failed') return 'warning';
        return 'download';
    }, [downloadState]);
    // Subtitles ride along with the download, and they are resolved HERE - on the tap - not
    // per row: asking every installed subtitle addon is one request each, and a stream list is
    // dozens of rows. The extra wait is capped inside fetchEnglishSubtitles, and an addon that
    // never answers costs the download nothing but that wait.
    const sending = React.useRef(false);
    const sendDownload = React.useCallback(async (scope) => {
        if (!stream || sending.current) {
            return;
        }

        sending.current = true;
        const addons = subtitleAddons(profile?.addons);
        const subtitles = await fetchEnglishSubtitles(addons, {
            type: meta?.type,
            videoId: video?.id ?? videoId ?? meta?.id
        });
        const sent = postToApp('download', buildDownloadPayload({ scope, meta, video, stream, addon, subtitles, addons }));
        sending.current = false;
        toast.show({
            type: sent ? 'success' : 'error',
            title: sent ?
                scope === 'season' ? 'Season sent to Downloads' : 'Sent to Downloads'
                :
                'The app did not take this download',
            timeout: 4000
        });
    }, [stream, addon, meta, video, videoId, profile]);
    // A tap on a nested action must not also open the row: the row is an anchor to the
    // player, and the popup label toggles its menu on long press.
    const downloadOnPointerDown = React.useCallback((event) => {
        event.nativeEvent.togglePopupPrevented = true;
    }, []);
    const downloadOnClick = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.togglePopupPrevented = true;
        closeMenu();
        sendDownload('episode');
    }, [sendDownload]);
    const downloadSeasonOnClick = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.togglePopupPrevented = true;
        closeMenu();
        sendDownload('season');
    }, [sendDownload]);

    const renderThumbnailFallback = React.useCallback(() => (
        <Icon className={styles['placeholder-icon']} name={'ic_broken_link'} />
    ), []);

    const renderLabel = React.useMemo(() => function renderLabel({ className, children, ...props }) {
        return (
            <Button className={classnames(className, styles['stream-container'])} title={addonName} href={href} target={target} download={download} onClick={onClick} {...props}>
                <div className={styles['info-container']}>
                    {
                        typeof thumbnail === 'string' && thumbnail.length > 0 ?
                            <div className={styles['thumbnail-container']} title={name || addonName}>
                                <Image
                                    className={styles['thumbnail']}
                                    src={thumbnail}
                                    alt={' '}
                                    renderFallback={renderThumbnailFallback}
                                />
                            </div>
                            :
                            <div className={styles['addon-name-container']} title={name || addonName}>
                                <div className={styles['addon-name']}>{name || addonName}</div>
                            </div>
                    }
                    {
                        progress !== null && !isNaN(progress) && progress > 0 ?
                            <div className={styles['progress-bar-container']}>
                                <div className={styles['progress-bar']} style={{ width: `${progress}%` }} />
                                <div className={styles['progress-bar-background']} />
                            </div>
                            :
                            null
                    }
                </div>
                <div className={styles['description-container']} title={description}>{description}</div>
                {
                    inApp && stream ?
                        <div className={styles['download-actions']}>
                            <Button
                                className={classnames(styles['download-button'], { [styles['download-active']]: downloadState !== null })}
                                title={downloadStateLabel !== null ? DOWNLOAD_LABEL + ' - ' + downloadStateLabel : DOWNLOAD_LABEL}
                                tabIndex={-1}
                                onPointerDown={downloadOnPointerDown}
                                onClick={downloadOnClick}
                            >
                                <Icon className={styles['download-icon']} name={downloadIconName} />
                                <div className={styles['download-label']}>{downloadStateLabel !== null ? downloadStateLabel : DOWNLOAD_LABEL}</div>
                            </Button>
                            {
                                canDownloadSeason ?
                                    <Button
                                        className={styles['download-button']}
                                        title={DOWNLOAD_SEASON_LABEL}
                                        tabIndex={-1}
                                        onPointerDown={downloadOnPointerDown}
                                        onClick={downloadSeasonOnClick}
                                    >
                                        <Icon className={styles['download-icon']} name={'episodes'} />
                                        <div className={styles['download-label']}>{DOWNLOAD_SEASON_LABEL}</div>
                                    </Button>
                                    :
                                    null
                            }
                        </div>
                        :
                        null
                }
                <Icon className={styles['icon']} name={'play'} />
                {children}
            </Button>
        );
    }, [thumbnail, progress, addonName, name, description, href, target, download, onClick, inApp, stream, canDownloadSeason, downloadState, downloadStateLabel, downloadIconName, downloadOnClick, downloadSeasonOnClick]);

    const renderMenu = React.useMemo(() => function renderMenu() {
        return (
            <div className={styles['context-menu-content']} onPointerDown={popupMenuOnPointerDown} onContextMenu={popupMenuOnContextMenu} onClick={popupMenuOnClick} onKeyDown={popupMenuOnKeyDown}>
                <div className={styles['context-menu-title']}>
                    {description}
                </div>
                <Button className={styles['context-menu-option-container']} title={t('CTX_PLAY')}>
                    <Icon className={styles['menu-icon']} name={'play'} />
                    <div className={styles['context-menu-option-label']}>{t('CTX_PLAY')}</div>
                </Button>
                {
                    // HomeIomp: the same two actions as the row, for the long-press menu.
                    inApp && stream ?
                        <React.Fragment>
                            <Button className={styles['context-menu-option-container']} title={DOWNLOAD_LABEL} onClick={downloadOnClick}>
                                <Icon className={styles['menu-icon']} name={downloadIconName} />
                                <div className={styles['context-menu-option-label']}>
                                    {downloadStateLabel !== null ? DOWNLOAD_LABEL + ' (' + downloadStateLabel + ')' : DOWNLOAD_LABEL}
                                </div>
                            </Button>
                            {
                                canDownloadSeason ?
                                    <Button className={styles['context-menu-option-container']} title={DOWNLOAD_SEASON_LABEL} onClick={downloadSeasonOnClick}>
                                        <Icon className={styles['menu-icon']} name={'episodes'} />
                                        <div className={styles['context-menu-option-label']}>{DOWNLOAD_SEASON_LABEL}</div>
                                    </Button>
                                    :
                                    null
                            }
                        </React.Fragment>
                        :
                        null
                }
                {
                    streamLink &&
                        <Button className={styles['context-menu-option-container']} title={t('CTX_COPY_STREAM_LINK')} onClick={copyStreamLink}>
                            <Icon className={styles['menu-icon']} name={'link'} />
                            <div className={styles['context-menu-option-label']}>{t('CTX_COPY_STREAM_LINK')}</div>
                        </Button>
                }
                {
                    magnetLink &&
                        <Button className={styles['context-menu-option-container']} title={t('CTX_COPY_MAGNET_LINK')} onClick={copyMagnetLink}>
                            <Icon className={styles['menu-icon']} name={'magnet-link'} />
                            <div className={styles['context-menu-option-label']}>{t('CTX_COPY_MAGNET_LINK')}</div>
                        </Button>
                }
                {
                    downloadLink &&
                        <Button className={styles['context-menu-option-container']} title={t('CTX_DOWNLOAD_VIDEO')} onClick={copyDownloadLink}>
                            <Icon className={styles['menu-icon']} name={'download'} />
                            <div className={styles['context-menu-option-label']}>{t('CTX_COPY_VIDEO_DOWNLOAD_LINK')}</div>
                        </Button>
                }
            </div>
        );
    }, [copyStreamLink, onClick, inApp, stream, canDownloadSeason, downloadStateLabel, downloadIconName, downloadOnClick, downloadSeasonOnClick]);

    React.useEffect(() => {
        if (!routeFocused) {
            closeMenu();
        }
    }, [routeFocused]);

    return (
        <Popup
            className={className}
            onMouseUp={popupLabelOnMouseUp}
            onLongPress={popupLabelOnLongPress}
            onContextMenu={popupLabelOnContextMenu}
            open={menuOpen}
            onCloseRequest={closeMenu}
            renderLabel={renderLabel}
            renderMenu={renderMenu}
        />
    );
};

Stream.Placeholder = StreamPlaceholder;

Stream.propTypes = {
    className: PropTypes.string,
    videoId: PropTypes.string,
    videoReleased: PropTypes.instanceOf(Date),
    addonName: PropTypes.string,
    name: PropTypes.string,
    description: PropTypes.string,
    thumbnail: PropTypes.string,
    progress: PropTypes.number,
    deepLinks: PropTypes.shape({
        player: PropTypes.string,
        externalPlayer: PropTypes.shape({
            download: PropTypes.string,
            magnet: PropTypes.string,
            streaming: PropTypes.string,
            playlist: PropTypes.string,
            fileName: PropTypes.string,
            web: PropTypes.string,
            openPlayer: PropTypes.shape({
                ios: PropTypes.string,
                android: PropTypes.string,
                windows: PropTypes.string,
                macos: PropTypes.string,
                linux: PropTypes.string,
            })
        })
    }),
    // HomeIomp: the raw core objects the download bridge posts to the native app. They are
    // read only when the app is hosting the page; in a browser they are ignored.
    stream: PropTypes.object,
    addon: PropTypes.object,
    meta: PropTypes.object,
    video: PropTypes.object,
    canDownloadSeason: PropTypes.bool,
    onClick: PropTypes.func
};

module.exports = Stream;
