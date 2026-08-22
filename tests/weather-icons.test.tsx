// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import {afterEach} from 'vitest';

import {
  WEATHER_CONDITIONS,
  conditionFromCode,
  conditionFromSummary,
  describeWeatherCode
} from '../src/mastra/lib/weather-conditions';
import {WeatherIcon} from '../src/app/components/WeatherIcon';
import {ItineraryCard} from '../src/app/components/ItineraryCard';

/**
 * The forecast glyph.
 *
 * The condition is a lookup against the same WMO table the weather tool
 * publishes from, so the icon and the sentence beside it always describe one
 * forecast. Nothing here reads model text: an unrecognised summary is `unknown`
 * rather than a guess.
 */

afterEach(cleanup);

function conditionOf(summary: string): string | null {
  const {container} = render(<WeatherIcon summary={summary} />);
  const svg = container.querySelector('svg');
  return svg?.getAttribute('data-condition') ?? null;
}

describe('classifying a WMO code', () => {
  it.each([
    [0, 'clear'],
    [1, 'clear'],
    [2, 'partly-cloudy'],
    [3, 'cloudy'],
    [45, 'fog'],
    [48, 'fog'],
    [51, 'drizzle'],
    [55, 'drizzle'],
    [61, 'light-rain'],
    [63, 'rain'],
    [65, 'rain'],
    [71, 'snow'],
    [75, 'snow'],
    [80, 'light-rain'],
    [82, 'rain'],
    [95, 'thunderstorm'],
    [99, 'thunderstorm']
  ])('maps code %i to %s', (code, expected) => {
    expect(conditionFromCode(code)).toBe(expected);
  });

  it('returns unknown for a code Open-Meteo does not define', () => {
    expect(conditionFromCode(1234)).toBe('unknown');
    expect(describeWeatherCode(1234)).toBe('Mixed conditions');
  });
});

describe('classifying a forecast summary', () => {
  // Every description this application can produce must classify exactly.
  it('classifies every description the weather tool publishes', () => {
    for (let code = 0; code <= 99; code += 1) {
      const description = describeWeatherCode(code);
      if (description === 'Mixed conditions') continue;

      expect(conditionFromSummary(description), description).toBe(conditionFromCode(code));
    }
  });

  it.each([
    ['Clear sky', 'clear'],
    ['Partly cloudy', 'partly-cloudy'],
    ['Overcast', 'cloudy'],
    ['Fog', 'fog'],
    ['Moderate drizzle', 'drizzle'],
    ['Light rain', 'light-rain'],
    ['Light rain showers', 'light-rain'],
    ['Heavy rain', 'rain'],
    ['Moderate snowfall', 'snow'],
    ['Thunderstorm with hail', 'thunderstorm']
  ])('renders %s as the %s icon', (summary, expected) => {
    expect(conditionOf(summary)).toBe(expected);
  });

  it('falls back to keywords when a summary has been reworded', () => {
    expect(conditionFromSummary('Sunny spells')).toBe('clear');
    expect(conditionFromSummary('heavy showers later')).toBe('rain');
    expect(conditionFromSummary('misty start')).toBe('fog');
  });

  it('never guesses when the summary means nothing', () => {
    expect(conditionOf('')).toBe('unknown');
    expect(conditionOf('bananas')).toBe('unknown');
  });

  it('has a glyph for every condition it can produce', () => {
    for (const condition of WEATHER_CONDITIONS) {
      // Reaching a condition through a description proves it has a glyph.
      const {container} = render(<WeatherIcon summary={condition} />);
      expect(container.querySelector('svg')).not.toBeNull();
      cleanup();
    }
  });
});

describe('how the icon is announced', () => {
  it('is hidden from assistive technology when text names the condition', () => {
    const {container} = render(<WeatherIcon summary="Light rain" />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
  });

  it('becomes an image with a name when it stands alone', () => {
    render(<WeatherIcon summary="Light rain" label="Light rain" />);
    const icon = screen.getByRole('img', {name: 'Light rain'});

    expect(icon.getAttribute('aria-hidden')).toBeNull();
  });

  it('carries meaning in shape, not colour', () => {
    const {container} = render(<WeatherIcon summary="Thunderstorm" />);
    const svg = container.querySelector('svg');

    // Colour is inherited, never set — the glyph itself distinguishes it.
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('fill')).toBe('none');
  });
});

describe('the itinerary shows the forecast icon', () => {
  const ITINERARY = {
    destination: 'Lagos',
    date: '2026-08-22',
    summary: 'An afternoon in Lagos.',
    weather: {
      summary: 'Light rain showers',
      highCelsius: 27,
      lowCelsius: 25,
      precipitationChance: 100,
      considerations: []
    },
    activities: [
      {
        order: 1,
        name: 'Terra Kulture',
        startTime: '13:00',
        durationMinutes: 120,
        category: 'culture',
        location: 'Victoria Island',
        description: 'Arts centre.',
        weatherDependent: false
      }
    ],
    notes: []
  };

  it('renders the icon matching the forecast it was given', () => {
    const {container} = render(<ItineraryCard itinerary={ITINERARY as never} />);
    const icon = container.querySelector('.weather-strip .weather-icon');

    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-condition')).toBe('light-rain');
    // The condition is written out beside it, so the glyph is decorative.
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Light rain showers')).toBeDefined();
  });

  it('changes with the forecast', () => {
    const snowy = {...ITINERARY, weather: {...ITINERARY.weather, summary: 'Heavy snowfall'}};
    const {container} = render(<ItineraryCard itinerary={snowy as never} />);

    expect(container.querySelector('.weather-icon')?.getAttribute('data-condition')).toBe('snow');
  });
});
