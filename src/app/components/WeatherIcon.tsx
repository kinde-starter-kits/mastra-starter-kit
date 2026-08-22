import {conditionFromSummary, type WeatherCondition} from '../../mastra/lib/weather-conditions';

/**
 * A forecast glyph, drawn rather than typed.
 *
 * Emoji were the obvious shortcut and the wrong one: they render differently on
 * every platform, carry their own colour, and cannot be aligned reliably beside
 * text. These are inline strokes instead — they inherit `currentColor` and the
 * surrounding font size, so a condition never depends on colour alone and never
 * competes with the text next to it.
 *
 * The condition comes from the shared WMO table, so the glyph and the sentence
 * beside it are always derived from the same forecast.
 *
 * Accessibility: the icon is decorative wherever the condition is already
 * written out next to it, which is the normal case. Pass a `label` only when
 * the icon stands alone, and it becomes an image with an accessible name.
 */

const SIZE = '1.25em';

function Sun() {
  return (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  );
}

function Cloud() {
  return <path d="M7 18h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1.2A3.9 3.9 0 0 0 7 18Z" />;
}

function SunBehindCloud() {
  return (
    <>
      <circle cx="8" cy="7.5" r="3" />
      <path d="M8 1.5v1.4M3.4 3.4l1 1M1.5 8h1.4M12.6 3.4l-1 1" />
      <path d="M9 19h8a3 3 0 0 0 .3-6 4.3 4.3 0 0 0-8.2-1A3.4 3.4 0 0 0 9 19Z" />
    </>
  );
}

/** Cloud plus a stroke pattern beneath it, shared by every precipitation type. */
function Precipitation({children}: {children: React.ReactNode}) {
  return (
    <>
      <path d="M7 15h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1.2A3.9 3.9 0 0 0 7 15Z" />
      {children}
    </>
  );
}

const GLYPHS: Record<WeatherCondition, React.ReactNode> = {
  clear: <Sun />,
  'partly-cloudy': <SunBehindCloud />,
  cloudy: <Cloud />,
  fog: (
    <>
      <path d="M7 13h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1.2A3.9 3.9 0 0 0 7 13Z" />
      <path d="M4 17h16M6 21h12" />
    </>
  ),
  drizzle: (
    <Precipitation>
      <path d="M9 18.5v1M13 18.5v1M17 18.5v1" />
    </Precipitation>
  ),
  'light-rain': (
    <Precipitation>
      <path d="M9 18v2M14 18v2" />
    </Precipitation>
  ),
  rain: (
    <Precipitation>
      <path d="M8 18l-1 3M12.5 18l-1 3M17 18l-1 3" />
    </Precipitation>
  ),
  snow: (
    <Precipitation>
      <path d="M9 19h.01M13 19h.01M17 19h.01M11 21.5h.01M15 21.5h.01" />
    </Precipitation>
  ),
  thunderstorm: (
    <Precipitation>
      <path d="M13 17l-3 4h3l-1 3" />
    </Precipitation>
  ),
  // Never a guess: an unrecognised forecast shows a neutral mark.
  unknown: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16h.01M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.4" />
    </>
  )
};

export function WeatherIcon({
  summary,
  label,
  className
}: {
  /** The forecast sentence, as published by the weather tool. */
  summary: string;
  /** Supply only when no adjacent text names the condition. */
  label?: string;
  className?: string;
}) {
  const condition = conditionFromSummary(summary);
  const decorative = !label;

  return (
    <svg
      className={className ? `weather-icon ${className}` : 'weather-icon'}
      data-condition={condition}
      width={SIZE}
      height={SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={decorative ? 'true' : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={label}
      focusable="false"
    >
      {GLYPHS[condition]}
    </svg>
  );
}
