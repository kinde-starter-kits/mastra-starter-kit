// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {render, screen, waitFor, cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type {AgentResponse} from '../src/mastra/schemas/agent-response.js';

// --- doubles ---------------------------------------------------------------

const auth = {
  isLoading: false,
  isAuthenticated: true,
  user: {email: 'alice@example.com'},
  login: vi.fn(),
  logout: vi.fn(),
  getAccessToken: vi.fn(async () => 'test-token')
};

vi.mock('@kinde-oss/kinde-auth-react', () => ({
  useKindeAuth: () => auth
}));

const runPlanTrip = vi.fn();
const fetchIdentity = vi.fn();

vi.mock('../src/app/lib/mastra-client', async () => {
  const actual = await vi.importActual<typeof import('../src/app/lib/mastra-client')>(
    '../src/app/lib/mastra-client'
  );
  return {
    ...actual,
    runPlanTrip: (...args: unknown[]) => runPlanTrip(...args),
    fetchIdentity: (...args: unknown[]) => fetchIdentity(...args)
  };
});

const {App} = await import('../src/app/App');
const {MastraRequestError} = await import('../src/app/lib/mastra-client');

// --- fixtures --------------------------------------------------------------

const ITINERARY = {
  destination: 'Lagos',
  date: '2026-08-22',
  summary: 'An easy afternoon built around the forecast.',
  weather: {
    summary: 'Moderate drizzle',
    highCelsius: 27.2,
    lowCelsius: 24.8,
    precipitationChance: 100,
    considerations: ['Indoor stop scheduled for the wettest hours']
  },
  activities: [
    {
      order: 2,
      name: 'Dinner at Yellow Chilli',
      category: 'food',
      startTime: '18:30',
      durationMinutes: 90,
      location: 'Victoria Island, Lagos',
      description: 'Modern Nigerian cooking.',
      weatherDependent: false
    },
    {
      order: 1,
      name: 'Nike Art Gallery',
      category: 'culture',
      startTime: '14:00',
      durationMinutes: 90,
      location: 'Lekki, Lagos',
      description: 'Five floors of Nigerian art.',
      weatherDependent: false
    }
  ],
  notes: ['Carry a light rain jacket']
};

const IDENTITY = {
  sub: 'kp:user_alice',
  orgCode: 'org_alpha',
  permissions: ['read:itinerary'],
  resourceId: 'org_alpha:kp:user_alice',
  can: {readItinerary: true, createItinerary: false},
  claimWarnings: []
};

const itineraryResponse: AgentResponse = {kind: 'itinerary', itinerary: ITINERARY} as AgentResponse;

beforeEach(() => {
  vi.clearAllMocks();
  auth.isLoading = false;
  auth.isAuthenticated = true;
  fetchIdentity.mockResolvedValue(IDENTITY);
  runPlanTrip.mockResolvedValue(itineraryResponse);
});

afterEach(cleanup);

/** Submit the planning form and wait for the request to be issued. */
async function plan(message?: string) {
  const user = userEvent.setup();
  const box = screen.getByLabelText(/your request/i);
  if (message !== undefined) {
    await user.clear(box);
    await user.type(box, message);
  }
  await user.click(screen.getByRole('button', {name: /plan my day/i}));
  return user;
}

// --- tests -----------------------------------------------------------------

describe('unauthenticated', () => {
  it('shows a sign-in call to action and no planner', () => {
    auth.isAuthenticated = false;
    render(<App />);

    expect(screen.getByRole('button', {name: /sign in with kinde/i})).toBeDefined();
    expect(screen.queryByLabelText(/your request/i)).toBeNull();
  });

  it('shows a loading state while Kinde initialises', () => {
    auth.isLoading = true;
    render(<App />);

    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
  });
});

describe('authenticated planning', () => {
  it('shows identity and organization', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('org_alpha')).toBeDefined());
    expect(screen.getByText('alice@example.com')).toBeDefined();
  });

  it('sends the request to the workflow with a thread id and no identity fields', async () => {
    render(<App />);
    await plan('Plan me an afternoon in Lagos.');

    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(1));

    const [token, input] = runPlanTrip.mock.calls[0] as [string, Record<string, unknown>];
    expect(token).toBe('test-token');
    expect(input.message).toBe('Plan me an afternoon in Lagos.');
    expect(typeof input.threadId).toBe('string');
    expect(input).not.toHaveProperty('resourceId');
    expect(input).not.toHaveProperty('sub');
    expect(input).not.toHaveProperty('orgCode');
  });

  it('shows a loading state while the workflow runs', async () => {
    let release: (value: AgentResponse) => void = () => {};
    runPlanTrip.mockReturnValue(new Promise<AgentResponse>(resolve => (release = resolve)));

    render(<App />);
    await plan('Plan something.');

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/checking the weather/i)
    );
    expect(screen.getByRole('button', {name: /planning/i})).toBeDefined();

    release(itineraryResponse);
    await waitFor(() => expect(screen.queryByText(/checking the weather/i)).toBeNull());
  });
});

describe('itinerary rendering', () => {
  it('renders the plan as a card, not raw JSON', async () => {
    render(<App />);
    await plan();

    await waitFor(() => expect(screen.getByText('Lagos')).toBeDefined());

    expect(screen.getByText(/an easy afternoon built around the forecast/i)).toBeDefined();
    expect(screen.getByText('Moderate drizzle')).toBeDefined();

    // High/low rounded, plus precipitation probability.
    const weather = document.querySelector('.weather')?.textContent ?? '';
    expect(weather).toContain('27°');
    expect(weather).toContain('25°');
    expect(weather).toContain('100%');
    expect(screen.getByText(/indoor stop scheduled/i)).toBeDefined();
    expect(screen.getByText(/carry a light rain jacket/i)).toBeDefined();

    // No JSON dump.
    expect(document.body.textContent).not.toContain('"destination"');
  });

  it('orders activities chronologically and shows time, duration and location', async () => {
    render(<App />);
    await plan();

    await waitFor(() => expect(screen.getByText('14:00')).toBeDefined());

    const names = Array.from(document.querySelectorAll('.activity h3')).map(n =>
      n.textContent?.trim()
    );
    expect(names[0]).toContain('Nike Art Gallery');
    expect(names[1]).toContain('Dinner at Yellow Chilli');

    expect(screen.getAllByText('1 hr 30 min')).toHaveLength(2);
    expect(screen.getByText('Lekki, Lagos')).toBeDefined();
  });
});

describe('saved-list rendering', () => {
  it('lists saved itineraries and can open one', async () => {
    runPlanTrip.mockResolvedValue({
      kind: 'saved-list',
      itineraries: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          itinerary: ITINERARY,
          sub: 'kp:user_alice',
          orgCode: 'org_alpha',
          resourceId: 'org_alpha:kp:user_alice',
          createdAt: '2026-08-20T10:30:00.000Z',
          updatedAt: '2026-08-20T10:30:00.000Z'
        }
      ]
    } as AgentResponse);

    render(<App />);
    const user = await plan('Show me my saved itineraries.');

    await waitFor(() => expect(screen.getByText(/1 saved itinerary/i)).toBeDefined());
    expect(screen.getByText('2026-08-22')).toBeDefined();

    // Details are collapsed until asked for.
    expect(screen.queryByText('Moderate drizzle')).toBeNull();
    await user.click(screen.getByRole('button', {expanded: false}));
    await waitFor(() => expect(screen.getByText('Moderate drizzle')).toBeDefined());
  });

  it('shows a clean empty state', async () => {
    runPlanTrip.mockResolvedValue({kind: 'saved-list', itineraries: []} as AgentResponse);

    render(<App />);
    await plan('Show me my saved itineraries.');

    await waitFor(() => expect(screen.getByText(/no saved itineraries yet/i)).toBeDefined());
  });
});

describe('permission denied', () => {
  it('renders a denial distinctly and names the permission', async () => {
    runPlanTrip.mockResolvedValue({
      kind: 'message',
      message: 'You do not have permission to save itineraries.',
      permissionDenied: true,
      requiredPermission: 'create:itinerary'
    } as AgentResponse);

    render(<App />);
    await plan('Save this itinerary.');

    await waitFor(() => expect(screen.getByText(/not permitted/i)).toBeDefined());

    const denial = document.querySelector('.card.denied');
    expect(denial).not.toBeNull();
    expect(denial?.textContent).toContain('create:itinerary');
  });

  it('renders an ordinary message without the denial styling', async () => {
    runPlanTrip.mockResolvedValue({
      kind: 'message',
      message: 'Saved your afternoon in Lagos.',
      permissionDenied: false,
      requiredPermission: null
    } as AgentResponse);

    render(<App />);
    await plan('Save this itinerary.');

    await waitFor(() => expect(screen.getByText(/saved your afternoon/i)).toBeDefined());
    expect(document.querySelector('.card.denied')).toBeNull();
  });

  it('does not infer denial from prose — the flag decides', async () => {
    // Mentions "permission" but was not a refusal. Must render as an ordinary
    // reply, proving the UI reads the flag rather than the wording.
    runPlanTrip.mockResolvedValue({
      kind: 'message',
      message: 'You already have permission to save itineraries, so go ahead.',
      permissionDenied: false,
      requiredPermission: null
    } as AgentResponse);

    render(<App />);
    await plan('Can I save this?');

    await waitFor(() => expect(screen.getByText(/already have permission/i)).toBeDefined());
    expect(document.querySelector('.card.denied')).toBeNull();
  });

  it('surfaces the permissions the user actually holds', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('.perms')).not.toBeNull());

    const pills = Array.from(document.querySelectorAll('.perms .pill'));
    const read = pills.find(p => p.textContent?.includes('read:itinerary'));
    const create = pills.find(p => p.textContent?.includes('create:itinerary'));

    expect(read?.className).toContain('yes');
    expect(create?.className).toContain('no');
  });
});

describe('errors', () => {
  it('shows a friendly message when the workflow fails', async () => {
    runPlanTrip.mockRejectedValue(
      new MastraRequestError(500, 'The planner is unavailable right now. Please try again.')
    );

    render(<App />);
    await plan('Plan something.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toMatch(/planner is unavailable/i);
  });

  it('never shows a raw error to the user', async () => {
    runPlanTrip.mockRejectedValue(new Error('SQLITE_ERROR: no such table: saved_itineraries'));

    render(<App />);
    await plan('Plan something.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(document.body.textContent).not.toContain('SQLITE_ERROR');
  });
});

describe('composer behaviour', () => {
  it('clears the box after a successful turn so the next request is easy', async () => {
    render(<App />);
    await plan('Plan me an afternoon in Lagos.');

    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByLabelText(/your request/i) as HTMLTextAreaElement).value).toBe('')
    );
  });

  it('keeps the request in the box when the turn fails', async () => {
    runPlanTrip.mockRejectedValue(new MastraRequestError(500, 'Nope.'));

    render(<App />);
    await plan('Plan me an afternoon in Lagos.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect((screen.getByLabelText(/your request/i) as HTMLTextAreaElement).value).toBe(
      'Plan me an afternoon in Lagos.'
    );
  });
});

describe('conversation threads', () => {
  it('keeps the same thread id across turns in one conversation', async () => {
    render(<App />);

    await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(1));

    await plan('Save this itinerary.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(2));

    const first = (runPlanTrip.mock.calls[0] as [string, {threadId: string}])[1].threadId;
    const second = (runPlanTrip.mock.calls[1] as [string, {threadId: string}])[1].threadId;
    expect(second).toBe(first);
  });

  it('starts a new thread for a new conversation', async () => {
    render(<App />);

    const user = await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', {name: /new conversation/i}));
    await waitFor(() => expect(screen.getByText(/nothing planned yet/i)).toBeDefined());

    await plan('Plan me a morning in Lisbon.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(2));

    const first = (runPlanTrip.mock.calls[0] as [string, {threadId: string}])[1].threadId;
    const second = (runPlanTrip.mock.calls[1] as [string, {threadId: string}])[1].threadId;
    expect(second).not.toBe(first);
  });
});
