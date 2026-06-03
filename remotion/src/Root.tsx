import {Composition} from 'remotion';
import {PublisherScene, publisherSceneSchema} from './PublisherScene';

// Canvas dimensions — derived from supplied assets
// iPhone UI: 1080x158, Creative area: 1080x2184
export const CANVAS_WIDTH  = 1080;
export const CANVAS_HEIGHT = 2342; // 158 + 2184

export const FPS = 30;

// Motion timing
export const SETTLE_SEC    = 0.6;
export const SCROLL_IN_SEC = 3.5;
export const HOLD_SEC      = 5.0;
export const SCROLL_OUT_SEC= 3.0;
export const TAIL_SEC      = 0.6;

export const TOTAL_SEC =
  SETTLE_SEC + SCROLL_IN_SEC + HOLD_SEC + SCROLL_OUT_SEC + TAIL_SEC;

export const TOTAL_FRAMES = Math.round(TOTAL_SEC * FPS); // 381

export function Root() {
  return (
    <Composition
      id="PublisherScene"
      component={PublisherScene}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      schema={publisherSceneSchema}
      defaultProps={{
        clipUrl:             '',
        publisherTopUrl:     '',
        publisherBottomUrl:  '',
        adBarTopUrl:         '',
        adBarBottomUrl:      '',
        iphoneUiUrl:         '',
        trimStart:           0,
        trimEnd:             10,
      }}
    />
  );
}
