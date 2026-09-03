// Copyright (C) 2017-2024 Smart code 203358507

// HomeIomp: "Restart Stremio server", in the settings screen rather than over SSH.
//
// WHY IT IS HERE AT ALL. The streaming server occasionally needs turning off and on
// again — a wedged transcode, a torrent engine that will not let go — and until now
// that meant the owner finding a terminal. It is the one operational act he actually
// wants from the sofa, so it belongs on the screen he is already looking at.
//
// WHAT IT CANNOT DO. Nothing here restarts anything. It POSTs to the offline
// service, which drops a request naming a REGISTERED JOB into the same mailbox the
// admin cockpit uses; a host-side consumer running as an ordinary user takes the
// command from the registry, never from the request. That route is gated exactly
// like every other one on that service (the shared Google session AND Cloudflare
// Access, admin emails only) — so this button is not the security boundary, it is
// just the thing that asks. See apps/stremio-offline/src/restart.js.
//
// WHY IT WATCHES RATHER THAN COUNTS. A restart takes a few seconds, and the thing a
// person does immediately after pressing it is press play. So "back up" is not a
// timer: it polls the streaming server's own /settings until it answers again. It
// also waits to see the server GO AWAY first, because a poll that succeeds before
// the restart has begun would tell the owner it was over when it had not started —
// with a ceiling (SETTLE_MS) so that missing the gap does not leave the button
// spinning for ever over a restart that plainly worked.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ModalDialog } from 'stremio/components';
import { Option } from 'stremio/routes/Settings/components';
import styles from './RestartServer.less';

// Untranslated string literals, the convention this fork already uses for
// house-added rows (see Settings/Info/Info.tsx): these are not upstream strings
// and adding them to the translation files would be claiming they are.
const ROW_LABEL = 'HomeIomp server';
const RESTART_LABEL = 'Restart';
const RESTARTING_LABEL = 'Restarting…';
const BACK_LABEL = 'Back up';
const CONFIRM_TITLE = 'Restart the Stremio server?';
const CONFIRM_BODY = 'Playing streams will stop and will need to be started again. Downloads that are being prepared carry on by themselves — they retry automatically once the server is back.';
const CANCEL_BUTTON = 'Cancel';
const CONFIRM_BUTTON = 'Restart';

/** The offline service, same origin, behind the same Access door as this page. */
const RESTART_URL = '/stremio/api/offline/server/restart';
/** How often the streaming server is asked whether it is listening again. */
const POLL_MS = 2000;
/** Give up saying anything useful after this and let the owner judge for himself. */
const READY_TIMEOUT_MS = 90000;
/** Past this we stop insisting on having SEEN it go down. See the header. */
const SETTLE_MS = 25000;

type Phase = 'idle' | 'confirming' | 'requesting' | 'restarting' | 'back' | 'failed';

type Props = {
    streamingServerUrl: string | null,
};

const settingsUrl = (base: string | null): string | null => {
    if (typeof base !== 'string' || base.length === 0) return null;
    return `${base.replace(/\/+$/, '')}/settings`;
};

const RestartServer = ({ streamingServerUrl }: Props) => {
    const [phase, setPhase] = useState<Phase>('idle');
    const [error, setError] = useState<string | null>(null);
    // Every timer and in-flight loop this component owns, so unmounting mid-restart
    // cannot leave a poll running against a page that is gone.
    const cancelled = useRef(false);
    useEffect(() => () => { cancelled.current = true; }, []);

    const waitForServer = useCallback(async () => {
        const probe = settingsUrl(streamingServerUrl);
        const startedAt = Date.now();
        let sawDown = false;
        for (;;) {
            if (cancelled.current) return;
            if (Date.now() - startedAt > READY_TIMEOUT_MS) {
                setError('The server has not answered yet. Give it a moment, then reload.');
                setPhase('failed');
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            if (cancelled.current) return;
            let up = false;
            try {
                // no-store: a cached 200 from before the restart would be the one
                // answer that looks exactly like success and means nothing.
                const response = probe ? await fetch(probe, { cache: 'no-store' }) : null;
                up = response !== null && response.ok;
            } catch {
                up = false;
            }
            if (!up) {
                sawDown = true;
                continue;
            }
            if (sawDown || Date.now() - startedAt > SETTLE_MS) {
                setPhase('back');
                return;
            }
        }
    }, [streamingServerUrl]);

    const restart = useCallback(async () => {
        setError(null);
        setPhase('requesting');
        try {
            const response = await fetch(RESTART_URL, {
                method: 'POST',
                credentials: 'include',
                cache: 'no-store',
                headers: { accept: 'application/json' },
            });
            if (!response.ok) {
                let message = `The server refused the restart (${response.status}).`;
                try {
                    const body = await response.json();
                    if (body && typeof body.error === 'string') message = body.error;
                } catch { /* keep the status line */ }
                setError(message);
                setPhase('failed');
                return;
            }
        } catch {
            setError('Could not reach HomeIomp to ask for the restart.');
            setPhase('failed');
            return;
        }
        if (cancelled.current) return;
        setPhase('restarting');
        void waitForServer();
    }, [waitForServer]);

    const onRestartClick = useCallback(() => { setPhase('confirming'); }, []);
    const onCancel = useCallback(() => { setPhase('idle'); }, []);

    // "Back up" is a result, not a state to live in: it returns the row to normal
    // after a few seconds so the next visit does not open on stale good news.
    useEffect(() => {
        if (phase !== 'back') return;
        const timer = setTimeout(() => { if (!cancelled.current) setPhase('idle'); }, 6000);
        return () => clearTimeout(timer);
    }, [phase]);

    const busy = phase === 'requesting' || phase === 'restarting';
    const buttonLabel = busy ? RESTARTING_LABEL : phase === 'back' ? BACK_LABEL : RESTART_LABEL;

    return (
        <React.Fragment>
            <Option className={styles['restart-container']} label={ROW_LABEL}>
                <Button
                    className={'button'}
                    title={CONFIRM_TITLE}
                    disabled={busy}
                    tabIndex={-1}
                    onClick={onRestartClick}
                >
                    <div className={styles['button-label']}>{buttonLabel}</div>
                </Button>
            </Option>
            {
                phase === 'failed' && error !== null ?
                    <div className={styles['restart-error']}>{error}</div>
                    :
                    null
            }
            {
                phase === 'confirming' ?
                    <ModalDialog
                        title={CONFIRM_TITLE}
                        onCloseRequest={onCancel}
                        buttons={[
                            { label: CANCEL_BUTTON, props: { onClick: onCancel } },
                            { label: CONFIRM_BUTTON, props: { onClick: restart } },
                        ]}
                    >
                        <div className={styles['confirm-body']}>{CONFIRM_BODY}</div>
                    </ModalDialog>
                    :
                    null
            }
        </React.Fragment>
    );
};

export default RestartServer;
