// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { useCore } = require('stremio/core');
const { withCoreSuspender, useProfile } = require('stremio/common');
const { CORE_DEFAULT_STREAMING_SERVER_URL, DEFAULT_STREAMING_SERVER_URL } = require('stremio/common/CONSTANTS');

// Marks that this browser has already been offered the build's default streaming server, so the
// default is applied at most once and never fights the user's own choice afterwards.
const STORAGE_KEY = 'stremio-default-streaming-server';

const readApplied = () => {
    try {
        return window.localStorage.getItem(STORAGE_KEY);
    } catch (_e) {
        return null;
    }
};

const markApplied = () => {
    try {
        window.localStorage.setItem(STORAGE_KEY, DEFAULT_STREAMING_SERVER_URL);
    } catch (_e) {
        // localStorage can be unavailable (private mode, blocked cookies); the default is simply
        // re-evaluated on the next load, which is harmless because it only ever replaces the
        // untouched stremio-core default.
    }
};

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1', '[::1]', ''];

const isLocalOrigin = () => {
    const hostname = window.location.hostname;
    return LOCAL_HOSTNAMES.includes(hostname) || hostname.endsWith('.localhost');
};

// Applies this build's default streaming server to a profile that has never had one configured.
// This is a *default*, not a hardcoded value: it is only written when the profile still holds the
// stremio-core built-in URL, it is never written twice, and Settings -> Streaming always wins.
const DefaultStreamingServerHandler = () => {
    const core = useCore();
    const profile = useProfile();
    const applied = React.useRef(false);

    React.useEffect(() => {
        if (applied.current) return;

        // Nothing to do when this build did not override the core default.
        if (DEFAULT_STREAMING_SERVER_URL === CORE_DEFAULT_STREAMING_SERVER_URL) {
            applied.current = true;
            return;
        }

        // An explicit ?streamingServerUrl=... takes precedence; SearchParamsHandler applies it.
        const { hash, search } = window.location;
        if (`${hash}${search}`.includes('streamingServerUrl=')) {
            applied.current = true;
            return;
        }

        // Local development (webpack dev server, `npm start`) keeps stremio-core's own default so
        // it talks to the streaming server running on the same machine, exactly as before.
        if (isLocalOrigin()) {
            applied.current = true;
            return;
        }

        // Already handled in this browser, whatever the user did with it afterwards.
        if (readApplied() === DEFAULT_STREAMING_SERVER_URL) {
            applied.current = true;
            return;
        }

        applied.current = true;

        // The user (or a previous session) already picked a server: respect it, just remember
        // that we are done so we never revisit this decision.
        if (profile.settings.streamingServerUrl !== CORE_DEFAULT_STREAMING_SERVER_URL) {
            markApplied();
            return;
        }

        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'AddServerUrl',
                args: DEFAULT_STREAMING_SERVER_URL,
            },
        });
        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'UpdateSettings',
                args: {
                    ...profile.settings,
                    streamingServerUrl: DEFAULT_STREAMING_SERVER_URL,
                },
            },
        });

        markApplied();
    }, [profile.settings]);

    return null;
};

module.exports = withCoreSuspender(DefaultStreamingServerHandler);
