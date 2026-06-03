import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from 'remotion';
import {z} from 'zod';

// ── Asset dimensions (from supplied files) ────────────────────────────────────
const W             = 1080;
const H             = 2342;
const IPHONE_UI_H   = 158;   // iPhone_UI_Layer.png height
const CREATIVE_H    = 2184;  // Creative_Recording_Size_Interscroller.jpg height
const CREATIVE_TOP  = H - CREATIVE_H; // = 158px (creative anchored to bottom)
const AD_BAR_TOP_H  = 41;   // Ad_Bar_Top.jpg height
const AD_BAR_BOT_H  = 37;   // Ad_Bar_Bottom.jpg height

// Publisher gap = full creative height
const PUB_GAP_H = CREATIVE_H; // 2184px

// ── Motion timing ─────────────────────────────────────────────────────────────
const FPS            = 30;
const SETTLE_F       = Math.round(0.6  * FPS); // 18
const SCROLL_IN_F    = Math.round(3.5  * FPS); // 105
const HOLD_F         = Math.round(5.0  * FPS); // 150
const SCROLL_OUT_F   = Math.round(3.0  * FPS); // 90
const TAIL_F         = Math.round(0.6  * FPS); // 18

// Frame ranges
const SCROLL_IN_START  = SETTLE_F;
const SCROLL_IN_END    = SETTLE_F + SCROLL_IN_F;
const HOLD_START       = SCROLL_IN_END;
const HOLD_END         = HOLD_START + HOLD_F;
const SCROLL_OUT_START = HOLD_END;
const SCROLL_OUT_END   = SCROLL_OUT_START + SCROLL_OUT_F;

// ── Schema ────────────────────────────────────────────────────────────────────
export const publisherSceneSchema = z.object({
  clipUrl:            z.string(),  // served via local HTTP from server
  publisherTopUrl:    z.string(),
  publisherBottomUrl: z.string(),
  adBarTopUrl:        z.string(),
  adBarBottomUrl:     z.string(),
  iphoneUiUrl:        z.string(),
  trimStart:          z.number(),  // seconds into the clip to start
  trimEnd:            z.number(),  // seconds into the clip to end
});

type Props = z.infer<typeof publisherSceneSchema>;

// ── Easing helper ─────────────────────────────────────────────────────────────
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function PublisherScene({
  clipUrl,
  publisherTopUrl,
  publisherBottomUrl,
  adBarTopUrl,
  adBarBottomUrl,
  iphoneUiUrl,
  trimStart,
  trimEnd,
}: Props) {
  const frame = useCurrentFrame();

  // ── Publisher overlay scroll position ───────────────────────────────────────
  // The publisher canvas (top image + adbar-top + gap + adbar-bottom + bottom image)
  // is taller than the viewport. We scroll it to reveal the gap (creative area).
  //
  // We don't know the publisher image heights at render time — they're passed
  // as URLs. We calculate the scroll target based on known dimensions:
  // The gap appears after [publisherTopH + AD_BAR_TOP_H] px from the top.
  // We want the gap centred in the viewport (H) during hold.
  //
  // Since we can't know publisherTopH at this point, we scroll to reveal
  // the gap starting at CREATIVE_TOP (158px) from the top of the viewport —
  // i.e. right below the iPhone UI. This means the publisher overlay scrolls
  // until its gap aligns with y=158 in the viewport.
  //
  // scrollY = (publisherTopH + AD_BAR_TOP_H) - CREATIVE_TOP
  // We pass this as a prop calculated server-side, OR we use a fixed
  // calculation: scroll until the gap top is at CREATIVE_TOP.
  //
  // For the animation, we define scroll as a 0→1 progress:
  //   0 = publisher overlay at top (article fully visible, gap below viewport)
  //   1 = publisher overlay scrolled so gap aligns with creative area

  let scrollProgress = 0;

  if (frame < SCROLL_IN_START) {
    // Settle — static at top
    scrollProgress = 0;
  } else if (frame < SCROLL_IN_END) {
    // Scroll in
    const t = (frame - SCROLL_IN_START) / SCROLL_IN_F;
    scrollProgress = easeInOutCubic(t);
  } else if (frame < HOLD_END) {
    // Hold
    scrollProgress = 1;
  } else if (frame < SCROLL_OUT_END) {
    // Scroll out
    const t = (frame - SCROLL_OUT_START) / SCROLL_OUT_F;
    scrollProgress = 1 + easeInOutCubic(t); // > 1 scrolls past the ad
  } else {
    // Tail — scrolled past
    scrollProgress = 2;
  }

  // The publisher overlay translateY:
  // At progress=0: overlay at top (y=0), article content fills screen
  // At progress=1: overlay scrolled up so gap aligns with creative area
  // At progress=2: overlay scrolled further past
  //
  // The actual scroll amount depends on publisher image heights.
  // We use CSS to handle this: the overlay is a tall flex column,
  // and we translate it upward. We use a ref-based measurement approach:
  // instead, we pass publisherTopScrollY as a prop from the server.

  // For now, use a reasonable estimate: publisher top content is ~3x viewport height
  // The server will pass the exact value via inputProps.
  const PUBLISHER_SCROLL_RANGE = (3 * H); // scrolls 3 viewports worth
  const translateY = -scrollProgress * PUBLISHER_SCROLL_RANGE;

  // Clip playback time — trimmed
  const clipDuration = trimEnd - trimStart;
  const clipStartTime = trimStart;

  return (
    <AbsoluteFill style={{ background: '#fff', width: W, height: H, overflow: 'hidden' }}>

      {/* ── Layer 1: Ad clip — fills creative area, anchored to bottom ── */}
      <div style={{
        position: 'absolute',
        top: CREATIVE_TOP,
        left: 0,
        width: W,
        height: CREATIVE_H,
        overflow: 'hidden',
        background: '#000',
      }}>
        {clipUrl ? (
          <OffthreadVideo
            src={clipUrl}
            startFrom={Math.round(clipStartTime * FPS)}
            endAt={Math.round(trimEnd * FPS)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
            muted
          />
        ) : (
          // Placeholder when no clip
          <div style={{ width: '100%', height: '100%', background: '#111' }} />
        )}
      </div>

      {/* ── Layer 2: Publisher overlay — scrolls over everything ── */}
      {/* This is a tall column: publisher_top + adbar_top + gap + adbar_bottom + publisher_bottom */}
      {/* It translates upward as the animation progresses */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: W,
        transform: `translateY(${translateY}px)`,
        // No height set — content determines height
      }}>
        {/* Publisher top image */}
        {publisherTopUrl && (
          <Img
            src={publisherTopUrl}
            style={{ display: 'block', width: W, height: 'auto' }}
          />
        )}

        {/* Ad bar top — stitched between publisher top and gap */}
        {adBarTopUrl && (
          <Img
            src={adBarTopUrl}
            style={{ display: 'block', width: W, height: AD_BAR_TOP_H }}
          />
        )}

        {/* Gap — transparent, creative area shows through */}
        <div style={{ width: W, height: PUB_GAP_H, background: 'transparent' }} />

        {/* Ad bar bottom — stitched between gap and publisher bottom */}
        {adBarBottomUrl && (
          <Img
            src={adBarBottomUrl}
            style={{ display: 'block', width: W, height: AD_BAR_BOT_H }}
          />
        )}

        {/* Publisher bottom image */}
        {publisherBottomUrl && (
          <Img
            src={publisherBottomUrl}
            style={{ display: 'block', width: W, height: 'auto' }}
          />
        )}
      </div>

      {/* ── Layer 3: iPhone UI — always on top ── */}
      {iphoneUiUrl && (
        <Img
          src={iphoneUiUrl}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: W,
            height: IPHONE_UI_H,
            display: 'block',
          }}
        />
      )}

    </AbsoluteFill>
  );
}
