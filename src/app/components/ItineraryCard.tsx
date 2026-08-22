import type {Itinerary} from '../lib/mastra-client';
import {WeatherIcon} from './WeatherIcon';

/**
 * The plan, as a document.
 *
 * This is the thing the user came for, so it is the only element allowed to be
 * visually loud — and even then it earns that with structure rather than
 * colour: a clear header, one band of weather figures, and a vertical timeline.
 *
 * Badges are rationed deliberately. Every property could be a pill, and the
 * result would be unreadable; only state that changes what you would *do* gets
 * one — whether a stop is exposed to the weather, and whether it suits the
 * forecast. Category and location are plain text.
 */

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** Sentence case from a schema enum: `culture` -> `Culture`. */
function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/[-_]/g, ' ');
}

export function ItineraryCard({
  itinerary,
  onSave,
  saved = false,
  saving = false
}: {
  itinerary: Itinerary;
  /** Sends an explicit save request. The server decides whether it happens. */
  onSave?: () => void;
  saved?: boolean;
  saving?: boolean;
}) {
  const {weather} = itinerary;

  return (
    <article className="card itinerary" aria-label={`Plan for ${itinerary.destination}`}>
      <header className="itinerary-head">
        <h2>{itinerary.destination}</h2>
        <p className="itinerary-date">{formatDate(itinerary.date)}</p>
        <p className="itinerary-summary">{itinerary.summary}</p>
      </header>

      <section className="weather-strip" aria-label="Forecast">
        {/* Decorative: the condition is spelled out in the panel beside it. */}
        <WeatherIcon summary={weather.summary} className="weather-strip-icon" />

        <div className="weather-metric">
          <span className="weather-value">{weather.precipitationChance}%</span>
          <span className="weather-key">Rain</span>
        </div>
        <div className="weather-metric">
          <span className="weather-value">
            {Math.round(weather.lowCelsius)}–{Math.round(weather.highCelsius)}°C
          </span>
          <span className="weather-key">Range</span>
        </div>
        <div className="weather-metric">
          <span className="weather-value">{weather.summary}</span>
          <span className="weather-key">Conditions</span>
        </div>
      </section>

      {weather.considerations.length > 0 ? (
        <ul className="considerations" aria-label="How the forecast shaped the plan">
          {weather.considerations.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <ol className="timeline">
        {[...itinerary.activities]
          .sort((a, b) => a.order - b.order)
          .map(activity => (
            <li key={`${activity.order}-${activity.name}`} className="activity">
              <div className="activity-when">
                <span className="activity-time">{activity.startTime}</span>
                <span className="activity-duration">
                  {formatDuration(activity.durationMinutes)}
                </span>
              </div>

              <div className="activity-body">
                <h3 className="activity-name">{activity.name}</h3>
                <p className="activity-where">
                  {label(activity.category)} · {activity.location}
                </p>
                <p className="activity-desc">{activity.description}</p>

                {activity.weatherDependent ? (
                  <p className="badges">
                    {/* Paired with a word, never colour alone. */}
                    <span className="badge weather">
                      <span aria-hidden="true">◐</span> Weather dependent
                    </span>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
      </ol>

      {itinerary.notes.length > 0 ? (
        <section className="itinerary-notes" aria-label="Notes">
          <h3>Notes</h3>
          <ul>
            {itinerary.notes.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {onSave || saved ? (
        <footer className="itinerary-foot">
          {saved ? (
            <span className="saved-flag">
              <span aria-hidden="true">✓</span> Saved
            </span>
          ) : (
            /*
             * The button always offers. Whether the save is permitted is the
             * server's decision, made against the verified Kinde token — the
             * browser never reads a permission to decide what to render, so a
             * user without `create:itinerary` gets the real refusal rather than
             * a guess made here.
             */
            <button type="button" className="btn ghost small" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save itinerary'}
            </button>
          )}
        </footer>
      ) : null}
    </article>
  );
}
