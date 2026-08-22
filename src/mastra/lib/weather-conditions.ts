/**
 * WMO weather codes, and the conditions they collapse to.
 *
 * Open-Meteo reports a numeric WMO code. The tool turns that into a sentence
 * for the model to copy into the itinerary, and until now the number itself was
 * thrown away — which left the browser with nothing to key an icon off except
 * prose. Rather than widen the itinerary schema and rely on the model to copy a
 * number it has no use for, both sides now derive from this one table: the tool
 * maps code -> description, and the browser maps that same description back to
 * a condition.
 *
 * That works because the vocabulary is closed. Every string the browser can see
 * was produced here, so classification is a lookup rather than an interpretation
 * of model text. Anything unrecognised is `unknown`, never a guess.
 *
 * Deliberately dependency-free so the browser can import it without pulling Zod
 * or anything else server-side into the bundle.
 */

export const WEATHER_CONDITIONS = [
  'clear',
  'partly-cloudy',
  'cloudy',
  'fog',
  'drizzle',
  'light-rain',
  'rain',
  'snow',
  'thunderstorm',
  'unknown'
] as const;

export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

/** WMO interpretation codes, with the condition each one belongs to. */
const WMO: Record<number, {description: string; condition: WeatherCondition}> = {
  0: {description: 'Clear sky', condition: 'clear'},
  1: {description: 'Mainly clear', condition: 'clear'},
  2: {description: 'Partly cloudy', condition: 'partly-cloudy'},
  3: {description: 'Overcast', condition: 'cloudy'},
  45: {description: 'Fog', condition: 'fog'},
  48: {description: 'Freezing fog', condition: 'fog'},
  51: {description: 'Light drizzle', condition: 'drizzle'},
  53: {description: 'Moderate drizzle', condition: 'drizzle'},
  55: {description: 'Heavy drizzle', condition: 'drizzle'},
  56: {description: 'Light freezing drizzle', condition: 'drizzle'},
  57: {description: 'Heavy freezing drizzle', condition: 'drizzle'},
  61: {description: 'Light rain', condition: 'light-rain'},
  63: {description: 'Moderate rain', condition: 'rain'},
  65: {description: 'Heavy rain', condition: 'rain'},
  66: {description: 'Light freezing rain', condition: 'light-rain'},
  67: {description: 'Heavy freezing rain', condition: 'rain'},
  71: {description: 'Light snowfall', condition: 'snow'},
  73: {description: 'Moderate snowfall', condition: 'snow'},
  75: {description: 'Heavy snowfall', condition: 'snow'},
  77: {description: 'Snow grains', condition: 'snow'},
  80: {description: 'Light rain showers', condition: 'light-rain'},
  81: {description: 'Moderate rain showers', condition: 'rain'},
  82: {description: 'Violent rain showers', condition: 'rain'},
  85: {description: 'Light snow showers', condition: 'snow'},
  86: {description: 'Heavy snow showers', condition: 'snow'},
  95: {description: 'Thunderstorm', condition: 'thunderstorm'},
  96: {description: 'Thunderstorm with hail', condition: 'thunderstorm'},
  99: {description: 'Thunderstorm with heavy hail', condition: 'thunderstorm'}
};

/** The sentence the tool publishes for a WMO code. */
export function describeWeatherCode(code: number): string {
  return WMO[code]?.description ?? 'Mixed conditions';
}

/** The condition a WMO code belongs to. */
export function conditionFromCode(code: number): WeatherCondition {
  return WMO[code]?.condition ?? 'unknown';
}

/** Every description this application can produce, lower-cased for lookup. */
const BY_DESCRIPTION = new Map<string, WeatherCondition>(
  Object.values(WMO).map(entry => [entry.description.toLowerCase(), entry.condition])
);

/**
 * Classify a forecast summary.
 *
 * The exact table lookup is tried first, which covers every string this
 * application generates. The keyword pass below only matters when a summary has
 * been reworded — an older stored itinerary, or a model that paraphrased rather
 * than copied — and is ordered most specific first so "light rain showers"
 * cannot be captured by the broader "rain" rule.
 */
export function conditionFromSummary(summary: string): WeatherCondition {
  const text = String(summary ?? '').trim().toLowerCase();
  if (!text) return 'unknown';

  const exact = BY_DESCRIPTION.get(text);
  if (exact) return exact;

  if (text.includes('thunder')) return 'thunderstorm';
  if (text.includes('snow') || text.includes('sleet')) return 'snow';
  if (text.includes('drizzle')) return 'drizzle';
  if (text.includes('light rain')) return 'light-rain';
  if (text.includes('rain') || text.includes('shower')) return 'rain';
  if (text.includes('fog') || text.includes('mist') || text.includes('haze')) return 'fog';
  if (text.includes('partly') || text.includes('mainly')) return 'partly-cloudy';
  if (text.includes('overcast') || text.includes('cloud')) return 'cloudy';
  if (text.includes('clear') || text.includes('sun')) return 'clear';

  return 'unknown';
}
