import {useState} from 'react';

import type {SavedItinerary} from '../lib/mastra-client';
import {ItineraryCard} from './ItineraryCard';

function formatSavedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function SavedList({itineraries}: {itineraries: SavedItinerary[]}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (itineraries.length === 0) {
    return (
      <article className="card empty">
        <h2>No saved itineraries yet</h2>
        <p className="muted">
          Plan a day, then ask to save it. Saving needs the <code>create:itinerary</code>{' '}
          permission in Kinde.
        </p>
      </article>
    );
  }

  return (
    <article className="card" aria-label="Saved itineraries">
      <header className="saved-head">
        <p className="eyebrow">Saved</p>
        <h2>
          {itineraries.length} saved {itineraries.length === 1 ? 'itinerary' : 'itineraries'}
        </h2>
      </header>

      <ul className="saved-list">
        {itineraries.map(saved => {
          const isOpen = openId === saved.id;
          return (
            <li key={saved.id} className={isOpen ? 'saved-item open' : 'saved-item'}>
              <button
                type="button"
                className="saved-toggle"
                aria-expanded={isOpen}
                onClick={() => setOpenId(isOpen ? null : saved.id)}
              >
                <span className="saved-main">
                  <strong>{saved.itinerary.destination}</strong>
                  <span className="muted">{saved.itinerary.date}</span>
                </span>
                <span className="saved-summary">{saved.itinerary.summary}</span>
                <span className="saved-meta">
                  Saved {formatSavedAt(saved.createdAt)}
                  <span className="chev" aria-hidden="true">
                    {isOpen ? '▲' : '▼'}
                  </span>
                </span>
              </button>

              {isOpen ? <ItineraryCard itinerary={saved.itinerary} /> : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
}
