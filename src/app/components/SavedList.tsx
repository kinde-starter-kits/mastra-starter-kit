import {useState} from 'react';

import type {SavedItinerary} from '../lib/mastra-client';
import {ItineraryCard} from './ItineraryCard';

/**
 * Plans the user saved earlier, exactly as `list-itineraries` returned them.
 *
 * Collapsed by default: a list of saved plans is for finding one, not reading
 * them all at once. Opening a row renders the same `ItineraryCard` a live plan
 * uses, so a saved plan and a fresh one are the same object to the reader.
 *
 * Deliberately thin on identity — what was saved and when, never who owns it.
 * Ownership was decided on the server, and repeating an org code or resource id
 * here would leak scoping internals into the interface for no benefit.
 */

function formatSavedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
}

function SavedRow({saved}: {saved: SavedItinerary}) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        className="saved-row saved-toggle"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="saved-where">
          {saved.itinerary.destination}
          <span className="muted"> · {saved.itinerary.date}</span>
        </span>
        <span className="saved-when">{formatSavedAt(saved.createdAt)}</span>
      </button>

      {open ? <ItineraryCard itinerary={saved.itinerary} /> : null}
    </li>
  );
}

export function SavedList({itineraries}: {itineraries: SavedItinerary[]}) {
  if (itineraries.length === 0) {
    return (
      <div className="card message">
        <p className="muted">No saved itineraries yet.</p>
      </div>
    );
  }

  return (
    <div className="saved-list-wrap">
      <p className="section-label">
        {itineraries.length} saved {itineraries.length === 1 ? 'itinerary' : 'itineraries'}
      </p>
      <ul className="saved-list" aria-label="Saved itineraries">
        {itineraries.map(saved => (
          <SavedRow key={saved.id} saved={saved} />
        ))}
      </ul>
    </div>
  );
}
