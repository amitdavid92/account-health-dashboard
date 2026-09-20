/**
 * The Guidde wordmark.
 *
 * The supplied asset is a red mark on a white JPEG background, which would show
 * as a white slab in dark mode. So it ships as `public/brand/guidde.png`: the
 * paper keyed out to transparency, alpha taken from each pixel's distance from
 * white so the anti-aliased curves stay smooth, cropped to the mark itself.
 *
 * It is then used as a CSS mask rather than an image, so the colour comes from
 * `--brand` and the mark is correct in both themes from one file. The asset's
 * own ink measures #CC0001, which is the value `--brand` carries in light mode.
 */

/** Intrinsic aspect ratio of public/brand/guidde.png (583 × 160). */
const RATIO = 583 / 160;

export function Logo({ size = 22 }: { size?: number }) {
  const mask = {
    WebkitMaskImage: "url(/brand/guidde.png)",
    maskImage: "url(/brand/guidde.png)",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskPosition: "center",
    maskPosition: "center",
  } as const;

  return (
    <span
      role="img"
      aria-label="Guidde"
      style={{
        display: "inline-block",
        width: size * RATIO,
        height: size,
        background: "var(--brand)",
        ...mask,
      }}
    />
  );
}
