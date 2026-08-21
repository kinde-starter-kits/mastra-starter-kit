import type {Itinerary} from '../lib/mastra-client';

const CATEGORY_ICONS: Record<string, string> = {
  outdoor: '🌤',
  indoor: '🏛',
  food: '🍽',
  culture: '🎭',
  nature: '🌿',
  nightlife: '🌙',
  shopping: '🛍',
  wellness: '💆'
};

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
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

export function ItineraryCard({itinerary}: {itinerary: Itinerary}) {
  return (
    <article className="card itinerary" aria-label={`Plan for ${itinerary.destination}`}>
      <header className="itinerary-head">
        <p className="eyebrow">Your plan</p>
        <h2>{itinerary.destination}</h2>
        <p className="date">{formatDate(itinerary.date)}</p>
        <p className="summary">{itinerary.summary}</p>
      </header>

      <section className="weather" aria-label="Weather">
        <div className="weather-top">
          <span className="weather-summary">{itinerary.weather.summary}</span>
          <span className="weather-stats">
            <span title="High">{Math.round(itinerary.weather.highCelsius)}°</span>
            <span className="sep">/</span>
            <span className="low" title="Low">
              {Math.round(itinerary.weather.lowCelsius)}°
            </span>
            <span className="rain" title="Chance of precipitation">
              💧 {itinerary.weather.precipitationChance}%
            </span>
          </span>
        </div>
        {itinerary.weather.considerations.length > 0 ? (
          <ul className="considerations">
            {itinerary.weather.considerations.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <ol className="timeline">
        {[...itinerary.activities]
          .sort((a, b) => a.order - b.order)
          .map(activity => (
            <li key={`${activity.order}-${activity.name}`} className="activity">
              <div className="when">
                <span className="time">{activity.startTime}</span>
                <span className="duration">{formatDuration(activity.durationMinutes)}</span>
              </div>
              <div className="what">
                <h3>
                  <span aria-hidden="true">{CATEGORY_ICONS[activity.category] ?? '📍'}</span>{' '}
                  {activity.name}
                </h3>
                <p className="meta">
                  <span className="tag">{activity.category}</span>
                  <span className="where">{activity.location}</span>
                  {activity.weatherDependent ? (
                    <span className="tag warn" title="Weather-dependent">
                      weather-dependent
                    </span>
                  ) : null}
                </p>
                <p className="desc">{activity.description}</p>
              </div>
            </li>
          ))}
      </ol>

      {itinerary.notes.length > 0 ? (
        <section className="notes" aria-label="Notes">
          <h4>Good to know</h4>
          <ul>
            {itinerary.notes.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
