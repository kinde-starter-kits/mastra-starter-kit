import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  TEST_DOMAIN,
  TEST_AUDIENCE,
  mintToken,
  startTestTenant,
  stopTestTenant
} from './helpers/kinde-test-tenant.js';
import {authenticatedContext} from './helpers/authenticated-context.js';

/**
 * Saving requires the user to have asked.
 *
 * This is not a style preference. During the real acceptance run the agent
 * called `save-itinerary` after "Start later." — an ordinary modification — and
 * did it twice in one session, despite instructions saying planning never
 * saves. A prompt cannot be relied on to hold a rule that writes to a database,
 * so the rule is enforced in the tool.
 *
 * Intent and permission are independent: intent asks "did they request this?",
 * the Kinde permission asks "are they allowed?". Both must hold, and neither
 * substitutes for the other.
 */

const dbDir = mkdtempSync(join(tmpdir(), 'mastra-save-intent-test-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'intent.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {hasExplicitSaveIntent, runWithSaveIntent, saveIntentGranted} = await import(
  '../src/mastra/lib/save-intent.js'
);
const {saveItinerary} = await import('../src/mastra/tools/save-itinerary.js');
const {listItineraries} = await import('../src/mastra/tools/list-itineraries.js');
const {PERMISSIONS} = await import('../src/mastra/lib/kinde.js');

const READ = PERMISSIONS.readItinerary;
const CREATE = PERMISSIONS.createItinerary;
const ORG = 'org_intent';

let mastra: Awaited<typeof import('../src/mastra/index.js')>['mastra'];

beforeAll(async () => {
  await startTestTenant();
  ({mastra} = await import('../src/mastra/index.js'));
});

afterAll(() => {
  stopTestTenant();
  rmSync(dbDir, {recursive: true, force: true});
});

async function contextFor(claims: {sub: string; permissions: string[]}) {
  const token = await mintToken({
    sub: claims.sub,
    orgCode: ORG,
    permissions: claims.permissions
  });
  const {requestContext} = await authenticatedContext(mastra, token);
  return requestContext;
}

const ITINERARY = {
  destination: 'Lagos',
  date: '2026-08-22',
  summary: 'An afternoon in Lagos.',
  weather: {summary: 'Sunny', highCelsius: 30, lowCelsius: 24, precipitationChance: 5},
  activities: [
    {
      order: 1,
      name: 'Terra Kulture',
      startTime: '13:00',
      durationMinutes: 120,
      category: 'indoor',
      location: 'Victoria Island',
      description: 'Arts centre.',
      weatherDependent: false
    }
  ],
  notes: []
};

describe('detecting explicit save intent', () => {
  it.each([
    'Save this itinerary.',
    'Save this.',
    'Save the plan.',
    'Keep this plan.',
    'Save this for me.',
    'save it',
    'Please remember this itinerary.',
    'Can you store this itinerary?',
    'Bookmark this plan.'
  ])('treats %j as a request to save', message => {
    expect(hasExplicitSaveIntent(message)).toBe(true);
  });

  it.each([
    'Plan my day.',
    'Plan my afternoon.',
    'Make it more relaxed.',
    'Change the second activity.',
    'What should I do tomorrow?',
    'Start later.',
    'Add one more activity.',
    'Remove the second stop.',
    'I want a relaxed afternoon in Lisbon.',
    // The trap: "keep" as an ordinary adjective request, not a save.
    'Keep it relaxed.',
    'Keep it short.',
    'Keep this casual.',
    ''
  ])('does not treat %j as a request to save', message => {
    expect(hasExplicitSaveIntent(message)).toBe(false);
  });
});

describe('the intent scope', () => {
  it('fails closed when no scope was established', () => {
    expect(saveIntentGranted()).toBe(false);
  });

  it('grants only inside the scope', () => {
    runWithSaveIntent('Save this.', () => expect(saveIntentGranted()).toBe(true));
    expect(saveIntentGranted()).toBe(false);
  });

  it('does not grant for an ordinary planning request', () => {
    runWithSaveIntent('Make it more relaxed.', () => expect(saveIntentGranted()).toBe(false));
  });
});

describe('the tool refuses an unrequested save', () => {
  it('refuses when the user never asked, even holding create:itinerary', async () => {
    const requestContext = await contextFor({sub: 'kp:planner', permissions: [READ, CREATE]});

    const result = await runWithSaveIntent('Make it more relaxed.', () =>
      saveItinerary({itinerary: ITINERARY} as never, {requestContext})
    );

    expect(result).toMatchObject({saved: false, reason: 'not_requested'});
  });

  it('refuses when no scope exists at all', async () => {
    const requestContext = await contextFor({sub: 'kp:noscope', permissions: [READ, CREATE]});

    const result = await saveItinerary({itinerary: ITINERARY} as never, {requestContext});

    expect(result).toMatchObject({saved: false, reason: 'not_requested'});
  });

  it('writes no database record when the save was not requested', async () => {
    const requestContext = await contextFor({sub: 'kp:norecord', permissions: [READ, CREATE]});

    await runWithSaveIntent('Plan my afternoon.', () =>
      saveItinerary({itinerary: ITINERARY} as never, {requestContext})
    );

    const listed = await listItineraries({limit: 10} as never, {requestContext});
    expect(listed.itineraries).toEqual([]);
  });

  it('names no permission, because permission was not the problem', async () => {
    const requestContext = await contextFor({sub: 'kp:noperm', permissions: [READ, CREATE]});

    const result = await runWithSaveIntent('Start later.', () =>
      saveItinerary({itinerary: ITINERARY} as never, {requestContext})
    );

    expect(result.requiredPermission).toBeNull();
  });
});

describe('an explicit save still respects Kinde permissions', () => {
  it('saves when the user asked and holds create:itinerary', async () => {
    const requestContext = await contextFor({sub: 'kp:allowed', permissions: [READ, CREATE]});

    const result = await runWithSaveIntent('Save this itinerary.', () =>
      saveItinerary({itinerary: ITINERARY} as never, {requestContext})
    );

    expect(result).toMatchObject({saved: true, reason: 'saved'});

    const listed = await listItineraries({limit: 10} as never, {requestContext});
    expect(listed.itineraries).toHaveLength(1);
  });

  it('denies an explicit save without create:itinerary and writes nothing', async () => {
    const requestContext = await contextFor({sub: 'kp:denied', permissions: [READ]});

    const result = await runWithSaveIntent('Save this itinerary.', () =>
      saveItinerary({itinerary: ITINERARY} as never, {requestContext})
    );

    expect(result).toMatchObject({
      saved: false,
      reason: 'permission_denied',
      requiredPermission: CREATE
    });

    const listed = await listItineraries({limit: 10} as never, {requestContext});
    expect(listed.itineraries).toEqual([]);
  });

  it('intent alone never substitutes for the permission', async () => {
    const requestContext = await contextFor({sub: 'kp:intentonly', permissions: []});

    const result = await runWithSaveIntent('Save this.', () =>
      saveItinerary({itinerary: ITINERARY} as never, {requestContext})
    );

    expect(result.saved).toBe(false);
  });
});
