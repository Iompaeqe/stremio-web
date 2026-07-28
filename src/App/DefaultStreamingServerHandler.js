// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { useCore } = require('stremio/core');
const { withCoreSuspender, useProfile, useModelState } = require('stremio/common');
const { CORE_DEFAULT_STREAMING_SERVER_URL, DEFAULT_STREAMING_SERVER_URL } = require('stremio/common/CONSTANTS');

// Hostnames that resolve back to whichever machine the browser itself is running on.
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1', '[::1]', ''];

const isLoopbackHostname = (hostname) => {
    const normalized = String(hostname).toLowerCase();
    return LOCAL_HOSTNAMES.includes(normalized) || normalized.endsWith('.localhost');
};

// Whether this page is being served locally — the desktop install — rather than from the public
// deployment, which is every browser that reached the app over the network.
const isLocalOrigin = () => isLoopbackHostname(window.location.hostname);

// Streaming server URLs have to be compared by shape rather than as strings: the value arrives
// from account sync, where a trailing slash or a spelled-out default port is not guaranteed either
// way, and treating those as a different server would make this handler fight itself.
const normalizeServerURL = (value) => {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch (_e) {
        return null;
    }

    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
};

const isSameServerURL = (a, b) => {
    const normalized = normalizeServerURL(a);
    return normalized !== null && normalized === normalizeServerURL(b);
};

// A streaming server on the same machine as the browser, whatever the port.
const isLoopbackServerURL = (value) => {
    if (typeof value !== 'string' || value.length === 0) {
        return false;
    }

    try {
        return isLoopbackHostname(new URL(value).hostname);
    } catch (_e) {
        return false;
    }
};

// Keeps this device pointed at a streaming server it can actually reach.
//
// The Stremio account syncs `streamingServerUrl` across every device on it, so the desktop install
// and the phone continuously overwrite each other: the desktop syncs its loopback URL onto the
// phone, where nothing is listening, and the phone syncs the public URL onto the desktop, which is
// behind an access-control layer it cannot pass. Applying a default once per browser loses that
// fight the moment the other device syncs again, so this runs on every settings change instead.
//
// Each origin only ever corrects the one value the *other* origin can put there, and rewrites it to
// the one thing this origin can reach. Anything else — a LAN hostname, a tunnel, whatever the user
// deliberately chose — is left alone, and because the two rules are mutually exclusive within a
// single origin neither device can ever ping-pong against itself.
const DefaultStreamingServerHandler = () => {
    const core = useCore();
    const profile = useProfile();
    const ctx = useModelState({ model: 'ctx' });

    React.useEffect(() => {
        // Nothing to enforce when this build did not override stremio-core's own default: the two
        // rules below would collapse into each other.
        if (isSameServerURL(DEFAULT_STREAMING_SERVER_URL, CORE_DEFAULT_STREAMING_SERVER_URL)) {
            return;
        }

        // An explicit ?streamingServerUrl=... takes precedence; SearchParamsHandler applies it.
        const { hash, search } = window.location;
        if (`${hash}${search}`.includes('streamingServerUrl=')) {
            return;
        }

        const current = profile.settings.streamingServerUrl;
        const localOrigin = isLocalOrigin();
        const target = localOrigin ? CORE_DEFAULT_STREAMING_SERVER_URL : DEFAULT_STREAMING_SERVER_URL;

        const clobbered = localOrigin ?
            // Desktop: this build's public URL can only have arrived from the phone, and the
            // desktop cannot get through the access-control layer in front of it.
            isSameServerURL(current, DEFAULT_STREAMING_SERVER_URL)
            :
            // Everywhere else: a loopback URL names a streaming server on the *viewer's* machine,
            // which on a phone or any other remote browser does not exist.
            isLoopbackServerURL(current);

        // The second half also covers a build whose default is itself a loopback URL, where the
        // rewrite would otherwise re-trigger on its own result.
        if (!clobbered || isSameServerURL(current, target)) {
            return;
        }

        // Registering the URL is what puts it in Settings -> Streaming; it is not part of the
        // enforcement, so only do it while the list does not already know about it.
        const knownServerUrls = Array.isArray(ctx.streamingServerUrls) ? ctx.streamingServerUrls : [];
        if (!knownServerUrls.some((item) => item && isSameServerURL(item.url, target))) {
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'AddServerUrl',
                    args: target,
                },
            });
        }

        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'UpdateSettings',
                args: {
                    ...profile.settings,
                    streamingServerUrl: target,
                },
            },
        });
    }, [profile.settings, ctx.streamingServerUrls]);

    return null;
};

module.exports = withCoreSuspender(DefaultStreamingServerHandler);
