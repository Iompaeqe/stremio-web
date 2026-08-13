// HomeIomp: the flash that confirms a double-tap seek, in the manner of every mobile video
// player: a soft round wash over the half of the screen that was tapped, a chevron pointing
// the way, and the distance travelled. It is feedback only - `pointer-events: none` all the
// way down, so it can never swallow the next tap in a chain.

import React from 'react';
import classNames from 'classnames';
import { default as Icon } from '@stremio/stremio-icons/react';
import styles from './SeekIndicator.less';

export type SeekFeedback = {
    // Which side was tapped, and therefore which way time moved.
    side: 'backward' | 'forward',
    // Total seconds travelled in this chain of taps, already accumulated.
    seconds: number,
    // Bumped on every tap so React remounts the element and the animation replays from the
    // start instead of continuing a half-finished one.
    id: number,
};

type Props = {
    className?: string,
    feedback: SeekFeedback | null,
};

const SeekIndicator = ({ className, feedback }: Props) => {
    if (feedback === null) return null;

    const backward = feedback.side === 'backward';

    return (
        <div className={classNames(className, styles['seek-indicator-container'], styles[feedback.side])}>
            <div key={feedback.id} className={styles['seek-indicator']}>
                <div className={styles['chevrons']}>
                    <Icon className={styles['icon']} name={backward ? 'chevron-back' : 'chevron-forward'} />
                    <Icon className={styles['icon']} name={backward ? 'chevron-back' : 'chevron-forward'} />
                </div>
                <div className={styles['label']}>
                    {backward ? '-' : '+'}{feedback.seconds}s
                </div>
            </div>
        </div>
    );
};

export default SeekIndicator;
