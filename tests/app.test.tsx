// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {act, render, screen, waitFor, cleanup} from '@testing-library/react';
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
const fetchConversations = vi.fn();
const fetchConversation = vi.fn();

vi.mock('../src/app/lib/mastra-client', async () => {
  const actual = await vi.importActual<typeof import('../src/app/lib/mastra-client')>(
    '../src/app/lib/mastra-client'
  );
  return {
    ...actual,
    // The app streams; the double stands in for the streaming call.
    streamPlanTrip: (...args: unknown[]) => runPlanTrip(...args),
    fetchIdentity: (...args: unknown[]) => fetchIdentity(...args),
    fetchConversations: (...args: unknown[]) => fetchConversations(...args),
    fetchConversation: (...args: unknown[]) => fetchConversation(...args)
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
  claimWarnings: [],
  ai: {provider: 'openai' as const, keySource: null}
};

const itineraryResponse: AgentResponse = {kind: 'itinerary', itinerary: ITINERARY} as AgentResponse;

beforeEach(() => {
  vi.clearAllMocks();
  auth.isLoading = false;
  auth.isAuthenticated = true;
  fetchIdentity.mockResolvedValue(IDENTITY);
  runPlanTrip.mockResolvedValue(itineraryResponse);
  fetchConversations.mockResolvedValue({conversations: []});
  fetchConversation.mockResolvedValue({
    threadId: 'thread-1', title: 'Lagos Afternoon',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    turns: []
  });
  localStorage.clear();
});

afterEach(cleanup);

/** Submit the planning form and wait for the request to be issued. */
async function plan(message = 'Plan me an afternoon in Lagos.') {
  const user = userEvent.setup();
  const box = screen.getByLabelText(/your request/i);
  await user.clear(box);
  await user.type(box, message);
  await user.click(screen.getByRole('button', {name: /send request/i}));
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

    expect(screen.getByRole('status').textContent).toMatch(/checking your session/i);
  });
});

describe('authenticated planning', () => {
  it('shows who is signed in without exposing scoping internals', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeDefined());

    // org_code, sub, resource id and permission arrays are how the server
    // scopes data; none of them belong on screen.
    const shown = document.body.textContent ?? '';
    expect(shown).not.toContain('org_alpha');
    expect(shown).not.toContain('kp:user_alice');
    expect(shown).not.toContain('org_alpha:kp:user_alice');
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

  it('reports progress from real events rather than a fixed message', async () => {
    // Before any telemetry arrives there is nothing to claim, so the panel says
    // only that work is happening. Each stage shown afterwards comes from an
    // event the server actually emitted.
    let release: (value: AgentResponse) => void = () => {};
    let emit: (event: unknown) => void = () => {};

    runPlanTrip.mockImplementation(
      (_token: unknown, _input: unknown, options: {onEvent?: (event: unknown) => void}) => {
        emit = options.onEvent ?? (() => {});
        return new Promise<AgentResponse>(resolve => (release = resolve));
      }
    );

    render(<App />);
    await plan('Plan something.');

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/working/i));
    expect(screen.getByRole('button', {name: /send request/i}).hasAttribute('disabled')).toBe(true);

    act(() =>
      emit({
        type: 'stage_started',
        marker: 'plan-execution-event',
        stage: 'weather',
        timestamp: '2026-08-21T10:00:00.000Z'
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/checking the weather/i)
    );

    release(itineraryResponse);
    await waitFor(() => expect(screen.queryByRole('button', {name: /cancel/i})).toBeNull());
  });

  it('shows a tool call only once the server reports it finished', async () => {
    let release: (value: AgentResponse) => void = () => {};
    let emit: (event: unknown) => void = () => {};

    runPlanTrip.mockImplementation(
      (_token: unknown, _input: unknown, options: {onEvent?: (event: unknown) => void}) => {
        emit = options.onEvent ?? (() => {});
        return new Promise<AgentResponse>(resolve => (release = resolve));
      }
    );

    render(<App />);
    await plan('Plan something.');
    await waitFor(() => expect(screen.getByRole('status')).toBeDefined());

    act(() =>
      emit({
        type: 'tool_completed',
        marker: 'plan-execution-event',
        tool: 'get-weather',
        durationMs: 1200,
        weather: {location: 'Lagos', date: '2026-08-22', condition: 'Sunny'},
        timestamp: '2026-08-21T10:00:01.000Z'
      })
    );

    await waitFor(() => expect(screen.getByText(/weather lookup/i)).toBeDefined());
    // The measured duration is reported, not an estimate.
    expect(screen.getByText('1.2s')).toBeDefined();
    expect(screen.getByText(/Lagos · Sunny/)).toBeDefined();

    release(itineraryResponse);
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
    const weather = document.querySelector('.weather-strip')?.textContent ?? '';
    expect(weather).toContain('25–27');
    expect(weather).toContain('100%');
    expect(weather).toContain('Moderate drizzle');
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

    expect(screen.getAllByText('1h 30m')).toHaveLength(2);
    // Category and location share one line: "Culture · Lekki, Lagos".
    expect(
      Array.from(document.querySelectorAll('.activity-where')).some(node =>
        node.textContent?.includes('Lekki, Lagos')
      )
    ).toBe(true);
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
    expect(document.querySelector('.saved-row')?.textContent).toContain('2026-08-22');

    // Details are collapsed until asked for.
    expect(screen.queryByText('Moderate drizzle')).toBeNull();
    // Scope to the saved list; the AI control also exposes aria-expanded.
    const toggle = document.querySelector('.saved-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await user.click(toggle);
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

  it('does not put the permission array on screen', async () => {
    // Permissions scope data on the server. Rendering them turned an ordinary
    // product surface into a debugging view, so the UI no longer shows them —
    // a refusal is surfaced when an action is actually attempted.
    render(<App />);
    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeDefined());

    const shown = document.body.textContent ?? '';
    expect(shown).not.toContain('read:itinerary');
    expect(shown).not.toContain('create:itinerary');
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

describe('conversation replay', () => {
  const CONVERSATIONS = [
    {threadId: 'thread-lagos', title: 'Lagos Afternoon', createdAt: '2026-08-20T10:00:00.000Z', updatedAt: '2026-08-21T10:00:00.000Z'},
    {threadId: 'thread-lisbon', title: 'Lisbon Weekend', createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-20T10:00:00.000Z'}
  ];

  const LAGOS_TURNS = [
    {
      id: '1',
      request: 'Plan me an afternoon in Lagos tomorrow.',
      response: itineraryResponse
    },
    {
      id: '2',
      request: 'Make it more relaxed.',
      response: {
        kind: 'message',
        message: 'I relaxed the pace.',
        permissionDenied: false,
        requiredPermission: null
      } as AgentResponse
    }
  ];

  it('rebuilds previous turns as the same cards a live run renders', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    render(<App />);

    // The request and the itinerary card both come back, not raw JSON.
    await waitFor(() =>
      expect(screen.getByText(/Plan me an afternoon in Lagos tomorrow\./)).toBeDefined()
    );
    expect(screen.getByText('I relaxed the pace.')).toBeDefined();
    expect(document.body.textContent).not.toContain('"kind"');
  });

  it('shows no execution timeline for a replayed turn', async () => {
    // The run is over; inventing a timeline for it would be fiction.
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('I relaxed the pace.')).toBeDefined());

    expect(document.querySelector('.execution')).toBeNull();
  });

  it('replaces the transcript when switching conversations', async () => {
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText('Lisbon Weekend')).toBeDefined());

    fetchConversation.mockResolvedValue({
      ...CONVERSATIONS[1],
      turns: [
        {
          id: '9',
          request: 'Plan a relaxed afternoon in Lisbon.',
          response: {
            kind: 'message',
            message: 'Here is Lisbon.',
            permissionDenied: false,
            requiredPermission: null
          } as AgentResponse
        }
      ]
    });

    await user.click(screen.getByText('Lisbon Weekend'));
    await waitFor(() => expect(screen.getByText('Here is Lisbon.')).toBeDefined());
    expect(screen.queryByText('I relaxed the pace.')).toBeNull();
  });

  it('continues a resumed conversation on its own thread', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('I relaxed the pace.')).toBeDefined());

    await plan('Start later.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());

    const [, input] = runPlanTrip.mock.calls.at(-1) as [unknown, {threadId: string}];
    expect(input.threadId).toBe('thread-lagos');
  });

  it('appends a new turn to the replayed ones rather than replacing them', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('I relaxed the pace.')).toBeDefined());

    await plan('Start later.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());

    await waitFor(() => expect(screen.getByText(/Start later\./)).toBeDefined());
    expect(screen.getByText('I relaxed the pace.')).toBeDefined();
  });

  it('clears replayed turns when a new conversation starts', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText('I relaxed the pace.')).toBeDefined());

    // Two controls offer this; either starts a fresh thread.
    await user.click(screen.getAllByRole('button', {name: /new plan/i})[0]);

    expect(screen.queryByText('I relaxed the pace.')).toBeNull();
    expect(localStorage.getItem('planmyday.activeThreadId')).toBeNull();
  });

  it('keeps no conversation content in browser storage', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('I relaxed the pace.')).toBeDefined());

    // Only the active thread id is ever persisted.
    expect(Object.keys(localStorage)).toEqual(['planmyday.activeThreadId']);
    const stored = JSON.stringify(localStorage) + JSON.stringify(sessionStorage);
    expect(stored).not.toContain('I relaxed the pace.');
    expect(stored).not.toContain('Lagos Afternoon');
  });

  it('does not carry a model key into replay', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: LAGOS_TURNS});

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    await user.click(screen.getByRole('button', {name: /add key/i}));
    await user.type(screen.getByLabelText(/api key/i), 'sk-replay-probe');
    await user.click(screen.getByRole('button', {name: /save key/i}));

    await waitFor(() => expect(screen.getByText('I relaxed the pace.')).toBeDefined());

    // The key is a header on live calls; replay must not surface it anywhere.
    expect(document.body.textContent).not.toContain('sk-replay-probe');
    expect(JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).not.toContain('sk-replay-probe');
    const replayCall = fetchConversation.mock.calls.at(-1) as unknown[];
    expect(JSON.stringify(replayCall)).not.toContain('sk-replay-probe');
  });
});

describe('conversation persistence wiring', () => {
  const CONVERSATIONS = [
    {threadId: 'thread-lagos', title: 'Lagos Afternoon', createdAt: '2026-08-20T10:00:00.000Z', updatedAt: '2026-08-21T10:00:00.000Z'},
    {threadId: 'thread-lisbon', title: 'Lisbon Weekend', createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-20T10:00:00.000Z'}
  ];

  it('lists the conversations the server returned', async () => {
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('Lagos Afternoon')).toBeDefined());
    expect(screen.getByText('Lisbon Weekend')).toBeDefined();
  });

  it('shows an empty state when there are none', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/no plans yet/i)).toBeDefined());
  });

  it('loads the conversation the user clicks', async () => {
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[1], turns: []});

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText('Lisbon Weekend')).toBeDefined());

    await user.click(screen.getByText('Lisbon Weekend'));
    await waitFor(() => expect(fetchConversation).toHaveBeenCalled());

    const [, requestedThread] = fetchConversation.mock.calls.at(-1) as [unknown, string];
    expect(requestedThread).toBe('thread-lisbon');
  });

  it('restores the remembered thread on startup when it belongs to the user', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: []});

    render(<App />);
    await waitFor(() => expect(fetchConversation).toHaveBeenCalled());
    const [, requestedThread] = fetchConversation.mock.calls.at(-1) as [unknown, string];
    expect(requestedThread).toBe('thread-lagos');
  });

  it('ignores a remembered thread that is not in the user list', async () => {
    // A stale or foreign id must never select someone else's conversation.
    localStorage.setItem('planmyday.activeThreadId', 'thread-belongs-to-someone-else');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('Lagos Afternoon')).toBeDefined());

    expect(fetchConversation).not.toHaveBeenCalled();
    expect(localStorage.getItem('planmyday.activeThreadId')).toBeNull();
  });

  it('recovers without an error state when loading fails', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockRejectedValue(new Error('gone'));

    render(<App />);
    await waitFor(() => expect(fetchConversation).toHaveBeenCalled());

    // No alert: a missing conversation just means "start a new plan".
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(localStorage.getItem('planmyday.activeThreadId')).toBeNull());
  });

  it('stores only the active thread id in localStorage, never contents', async () => {
    render(<App />);
    await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());

    await waitFor(() => expect(localStorage.getItem('planmyday.activeThreadId')).toBeTruthy());
    expect(Object.keys(localStorage)).toEqual(['planmyday.activeThreadId']);
    expect(JSON.stringify(localStorage)).not.toContain('Nike Art Gallery');
  });

  it('refreshes the conversation list after a completed turn', async () => {
    render(<App />);
    fetchConversations.mockClear();

    await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());
  });

  it('new conversation clears the transcript and the remembered thread', async () => {
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    const user = userEvent.setup();

    render(<App />);
    await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(screen.getByText('Lagos')).toBeDefined());

    const panelNew = screen.getByRole('button', {name: /new plan/i});
    await user.click(panelNew);

    await waitFor(() => expect(screen.getByText(/what's the plan/i)).toBeDefined());
    expect(localStorage.getItem('planmyday.activeThreadId')).toBeNull();
    // Existing conversations are untouched.
    expect(screen.getByText('Lagos Afternoon')).toBeDefined();
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

describe('AI key control (BYOK)', () => {
  it('offers a key when neither a session nor a server key exists', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    expect(screen.getByRole('button', {name: /add key/i})).toBeDefined();
    expect(screen.getByText(/no key configured/i)).toBeDefined();
  });

  it('reports a server-configured key without revealing it', async () => {
    fetchIdentity.mockResolvedValue({
      ...IDENTITY,
      ai: {provider: 'openai', keySource: 'server'}
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    await waitFor(() => expect(screen.getByText(/using server key/i)).toBeDefined());
    // The server's own key is never rendered, only the fact that one exists.
    expect(document.body.textContent).not.toMatch(/sk-/);
  });

  it('accepts a key, masks it, and sends it as a header value never shown on screen', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    await user.click(screen.getByRole('button', {name: /add key/i}));
    const input = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(input.type).toBe('password');

    await user.type(input, 'sk-my-secret-test-key');
    await user.click(screen.getByRole('button', {name: /save key/i}));

    await waitFor(() => expect(screen.getByText(/using your key/i)).toBeDefined());
    // The key is never rendered back to the page.
    expect(document.body.textContent).not.toContain('sk-my-secret-test-key');

    await plan('Plan me a day.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());

    // Passed as an option (it becomes a header), never inside the request body.
    const call = runPlanTrip.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
      {openaiKey?: string}
    ];
    expect(call[2].openaiKey).toBe('sk-my-secret-test-key');
    expect(JSON.stringify(call[1])).not.toContain('sk-my-secret-test-key');
  });

  it('never writes the key to browser storage', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    await user.click(screen.getByRole('button', {name: /add key/i}));
    await user.type(screen.getByLabelText(/api key/i), 'sk-storage-probe');
    await user.click(screen.getByRole('button', {name: /save key/i}));
    await waitFor(() => expect(screen.getByText(/using your key/i)).toBeDefined());

    expect(JSON.stringify(localStorage)).not.toContain('sk-storage-probe');
    expect(JSON.stringify(sessionStorage)).not.toContain('sk-storage-probe');
    expect(document.cookie).not.toContain('sk-storage-probe');
    expect(window.location.href).not.toContain('sk-storage-probe');
  });

  it('clearing the key stops sending it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    await user.click(screen.getByRole('button', {name: /add key/i}));
    await user.type(screen.getByLabelText(/api key/i), 'sk-to-be-cleared');
    await user.click(screen.getByRole('button', {name: /save key/i}));
    await waitFor(() => expect(screen.getByText(/using your key/i)).toBeDefined());

    // The menu is still open from saving the key.
    await user.click(screen.getByRole('button', {name: /clear key/i}));
    await waitFor(() => expect(screen.getByRole('button', {name: /add key/i})).toBeDefined());

    await plan('Plan me a day.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());
    const call = runPlanTrip.mock.calls.at(-1) as [string, unknown, {openaiKey?: string}];
    expect(call[2].openaiKey).toBeUndefined();
  });
});

describe('error categories', () => {
  it.each([
    ['model_key_missing', /OpenAI API key required/i],
    ['model_auth_failed', /OpenAI authentication failed/i],
    ['model_unreachable', /Could not reach OpenAI/i],
    ['workflow_failed', /Unable to build your plan/i]
  ])('renders a specific heading for %s', async (kind, heading) => {
    runPlanTrip.mockRejectedValue(new MastraRequestError(500, 'A friendly sentence.', kind as never));

    render(<App />);
    await plan('Plan me a day.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toMatch(heading);
  });

  it('hides technical detail behind a toggle and never shows a key', async () => {
    const user = userEvent.setup();
    runPlanTrip.mockRejectedValue(
      new MastraRequestError(500, 'Could not reach OpenAI.', 'model_unreachable', 'UND_ERR_SOCKET at api.openai.com')
    );

    render(<App />);
    await plan('Plan me a day.');
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());

    expect(screen.queryByText(/UND_ERR_SOCKET/)).toBeNull();
    await user.click(screen.getByRole('button', {name: /show details/i}));
    await waitFor(() => expect(screen.getByText(/UND_ERR_SOCKET/)).toBeDefined());
    expect(document.body.textContent).not.toMatch(/sk-[a-zA-Z0-9]/);
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

    await user.click(screen.getByRole('button', {name: /new plan/i}));
    await waitFor(() => expect(screen.getByText(/what's the plan/i)).toBeDefined());

    await plan('Plan me a morning in Lisbon.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(2));

    const first = (runPlanTrip.mock.calls[0] as [string, {threadId: string}])[1].threadId;
    const second = (runPlanTrip.mock.calls[1] as [string, {threadId: string}])[1].threadId;
    expect(second).not.toBe(first);
  });
});

/**
 * The product shell.
 *
 * These cover the surfaces the redesign introduced — sidebar, composer,
 * collapsing execution panel, save action, account menu — with the same rule as
 * everything else here: assert what a user can observe, and never assert that
 * something sensitive is merely hidden when it should be absent.
 */
describe('application shell', () => {
  const CONVERSATIONS = [
    {
      threadId: 'thread-lagos',
      title: 'Lagos Afternoon',
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: new Date().toISOString()
    },
    {
      threadId: 'thread-lisbon',
      title: 'Lisbon Weekend',
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: new Date(Date.now() - 86_400_000).toISOString()
    }
  ];

  it('lists conversations by title and relative day, never by thread id', async () => {
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});

    render(<App />);
    await waitFor(() => expect(screen.getByText('Lagos Afternoon')).toBeDefined());

    expect(screen.getByText('Today')).toBeDefined();
    expect(screen.getByText('Yesterday')).toBeDefined();

    const sidebar = document.querySelector('.sidebar')?.textContent ?? '';
    expect(sidebar).not.toContain('thread-lagos');
    expect(sidebar).not.toContain('thread-lisbon');
  });

  it('marks the active conversation for assistive technology, not just colour', async () => {
    localStorage.setItem('planmyday.activeThreadId', 'thread-lagos');
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], turns: []});

    render(<App />);
    await waitFor(() => expect(fetchConversation).toHaveBeenCalled());

    const active = document.querySelector('.conversation-item[aria-current="true"]');
    expect(active?.textContent).toContain('Lagos Afternoon');
  });

  it('shows an empty sidebar state before anything is planned', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/no plans yet/i)).toBeDefined());
  });

  it('reports a failed conversation list without leaking the error', async () => {
    fetchConversations.mockRejectedValue(new Error('SQLITE_ERROR: no such table'));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeDefined());
    expect(document.body.textContent).not.toContain('SQLITE_ERROR');
  });
});

describe('composer', () => {
  it('submits on Enter', async () => {
    const user = userEvent.setup();
    render(<App />);

    const box = screen.getByLabelText(/your request/i);
    await user.type(box, 'Plan me an afternoon in Lagos.{Enter}');

    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(1));
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup();
    render(<App />);

    const box = screen.getByLabelText(/your request/i) as HTMLTextAreaElement;
    await user.type(box, 'First line{Shift>}{Enter}{/Shift}second line');

    expect(box.value).toContain('\n');
    expect(runPlanTrip).not.toHaveBeenCalled();
  });

  it('disables input and sending while a run is in flight', async () => {
    let release: (value: AgentResponse) => void = () => {};
    runPlanTrip.mockReturnValue(new Promise<AgentResponse>(resolve => (release = resolve)));

    render(<App />);
    await plan('Plan something.');

    await waitFor(() =>
      expect(
        (screen.getByLabelText(/your request/i) as HTMLTextAreaElement).disabled
      ).toBe(true)
    );
    expect(screen.getByRole('button', {name: /send request/i}).hasAttribute('disabled')).toBe(true);

    release(itineraryResponse);
  });

  it('does not start a second run while one is already running', async () => {
    let release: (value: AgentResponse) => void = () => {};
    runPlanTrip.mockReturnValue(new Promise<AgentResponse>(resolve => (release = resolve)));

    render(<App />);
    const user = await plan('Plan something.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(1));

    // Enter while busy must not queue another run.
    await user.type(screen.getByLabelText(/your request/i), '{Enter}');
    expect(runPlanTrip).toHaveBeenCalledTimes(1);

    release(itineraryResponse);
  });

  it('keeps the request in the box when the run fails', async () => {
    runPlanTrip.mockRejectedValue(new MastraRequestError(500, 'Nope.'));

    render(<App />);
    await plan('Plan me an afternoon in Lagos.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect((screen.getByLabelText(/your request/i) as HTMLTextAreaElement).value).toBe(
      'Plan me an afternoon in Lagos.'
    );
  });

  it('offers follow-up hints only once there is something to follow up on', async () => {
    render(<App />);
    expect(screen.queryByRole('button', {name: /make it more relaxed/i})).toBeNull();

    const user = await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(document.querySelector('.itinerary')).not.toBeNull());

    // Each hint is a phrase the agent genuinely handles.
    await user.click(screen.getByRole('button', {name: /make it more relaxed/i}));
    expect((screen.getByLabelText(/your request/i) as HTMLTextAreaElement).value).toBe(
      'Make it more relaxed'
    );
  });
});

describe('execution panel lifecycle', () => {
  it('collapses to a summary once the run succeeds, and expands on click', async () => {
    let emit: (event: unknown) => void = () => {};
    let release: (value: AgentResponse) => void = () => {};

    runPlanTrip.mockImplementation(
      (_t: unknown, _i: unknown, options: {onEvent?: (event: unknown) => void}) => {
        emit = options.onEvent ?? (() => {});
        return new Promise<AgentResponse>(resolve => (release = resolve));
      }
    );

    render(<App />);
    const user = await plan('Plan something.');
    await waitFor(() => expect(document.querySelector('.execution')).not.toBeNull());

    act(() => {
      emit({
        type: 'tool_completed',
        marker: 'plan-execution-event',
        tool: 'get-weather',
        durationMs: 2000,
        timestamp: 'now'
      });
      emit({
        type: 'run_completed',
        marker: 'plan-execution-event',
        durationMs: 33500,
        timestamp: 'now'
      });
    });

    release(itineraryResponse);

    // Collapsed: the headline is there, the step detail is not.
    await waitFor(() => expect(screen.getByText(/planned in 33\.5s/i)).toBeDefined());
    expect(screen.getByText(/1 operation/i)).toBeDefined();
    expect(document.querySelector('.execution-body')).toBeNull();

    await user.click(screen.getByText(/planned in 33\.5s/i));
    await waitFor(() => expect(document.querySelector('.execution-body')).not.toBeNull());
  });

  it('keeps the timeline open when a run fails', async () => {
    runPlanTrip.mockRejectedValue(new MastraRequestError(500, 'Nope.'));

    render(<App />);
    await plan('Plan something.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(document.querySelector('.execution-failed')).not.toBeNull();
    expect(document.querySelector('.execution-body')).not.toBeNull();
  });

  it('renders each validation pass and the correction between them', async () => {
    let emit: (event: unknown) => void = () => {};
    let release: (value: AgentResponse) => void = () => {};

    runPlanTrip.mockImplementation(
      (_t: unknown, _i: unknown, options: {onEvent?: (event: unknown) => void}) => {
        emit = options.onEvent ?? (() => {});
        return new Promise<AgentResponse>(resolve => (release = resolve));
      }
    );

    render(<App />);
    await plan('Plan something.');
    await waitFor(() => expect(document.querySelector('.execution')).not.toBeNull());

    act(() => {
      emit({
        type: 'validation_completed',
        marker: 'plan-execution-event',
        valid: false,
        issueCount: 2,
        issueCodes: ['start_too_early', 'overlap'],
        timestamp: 'now'
      });
      emit({
        type: 'correction_started',
        marker: 'plan-execution-event',
        attempt: 1,
        timestamp: 'now'
      });
      emit({
        type: 'validation_completed',
        marker: 'plan-execution-event',
        valid: true,
        issueCount: 0,
        issueCodes: [],
        timestamp: 'now'
      });
    });

    await waitFor(() => expect(screen.getByText(/2 issues found/i)).toBeDefined());
    // Issue codes are translated, never dumped raw.
    expect(screen.getByText(/started earlier than you wanted/i)).toBeDefined();
    expect(document.body.textContent).not.toContain('start_too_early');
    expect(screen.getByText(/correcting the plan/i)).toBeDefined();
    expect(screen.getByText(/corrected plan is valid/i)).toBeDefined();

    release(itineraryResponse);
  });
});

describe('saving a plan', () => {
  it('sends an explicit save request rather than saving on its own', async () => {
    render(<App />);
    const user = await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(document.querySelector('.itinerary')).not.toBeNull());

    // Planning alone must never have saved anything.
    expect(runPlanTrip).toHaveBeenCalledTimes(1);

    runPlanTrip.mockResolvedValue({
      kind: 'message',
      message: 'Itinerary saved.',
      permissionDenied: false,
      requiredPermission: null
    } as AgentResponse);

    await user.click(screen.getByRole('button', {name: /save itinerary/i}));
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(2));

    const [, input] = runPlanTrip.mock.calls.at(-1) as [unknown, {message: string}];
    expect(input.message).toMatch(/save this itinerary/i);

    await waitFor(() => expect(screen.getByText(/^Saved$/)).toBeDefined());
  });

  it('shows the server refusal and does not mark the plan saved', async () => {
    render(<App />);
    const user = await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(document.querySelector('.itinerary')).not.toBeNull());

    runPlanTrip.mockResolvedValue({
      kind: 'message',
      message: 'You do not have permission to save itineraries.',
      permissionDenied: true,
      requiredPermission: 'create:itinerary'
    } as AgentResponse);

    await user.click(screen.getByRole('button', {name: /save itinerary/i}));
    await waitFor(() => expect(screen.getByText(/not permitted/i)).toBeDefined());

    // The refusal is the server's; the UI never decided it.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.getByText('create:itinerary')).toBeDefined();
  });
});

describe('account menu', () => {
  it('opens, closes on Escape, and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<App />);

    const trigger = await screen.findByRole('button', {name: /alice@example.com/i});
    await user.click(trigger);
    expect(screen.getByRole('dialog', {name: /account and settings/i})).toBeDefined();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('explains where the key goes without echoing one', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /alice@example.com/i}));
    expect(screen.getByText(/kept in memory only/i)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/sk-/);
  });
});

describe('mobile navigation', () => {
  it('opens the sidebar from the workspace and closes it on selection', async () => {
    fetchConversations.mockResolvedValue({
      conversations: [
        {
          threadId: 'thread-lagos',
          title: 'Lagos Afternoon',
          createdAt: '2026-08-20T10:00:00.000Z',
          updatedAt: '2026-08-21T10:00:00.000Z'
        }
      ]
    });
    fetchConversation.mockResolvedValue({
      threadId: 'thread-lagos',
      title: 'Lagos Afternoon',
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z',
      turns: []
    });

    const user = userEvent.setup();
    render(<App />);

    const toggle = screen.getByRole('button', {name: /show conversations/i});
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.sidebar.open')).not.toBeNull();

    await user.click(await screen.findByText('Lagos Afternoon'));
    await waitFor(() => expect(document.querySelector('.sidebar.open')).toBeNull());
  });
});

describe('recovering from a failed run', () => {
  it('offers to try the same request again without retyping it', async () => {
    runPlanTrip.mockRejectedValue(
      new MastraRequestError(
        500,
        'The model replied in a form the planner could not read.',
        'model_output_invalid' as never,
        'model_output_invalid'
      )
    );

    render(<App />);
    const user = await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());

    // A transient formatting failure is named as such, not blamed on the user.
    expect(screen.getByText(/couldn't produce a plan this time/i)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/try rephrasing/i);

    runPlanTrip.mockResolvedValue(itineraryResponse);
    await user.click(screen.getByRole('button', {name: /try again/i}));

    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(2));
    const [, input] = runPlanTrip.mock.calls.at(-1) as [unknown, {message: string}];
    expect(input.message).toBe('Plan me an afternoon in Lagos.');
  });

  it('keeps technical detail behind the existing toggle', async () => {
    runPlanTrip.mockRejectedValue(
      new MastraRequestError(500, 'Nope.', 'workflow_failed' as never, 'internal detail here')
    );

    render(<App />);
    const user = await plan('Plan something.');
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());

    expect(screen.queryByText(/internal detail here/i)).toBeNull();
    await user.click(screen.getByRole('button', {name: /show details/i}));
    expect(screen.getByText(/internal detail here/i)).toBeDefined();
  });
});

describe('the empty workspace', () => {
  it('offers example requests that fill the composer', async () => {
    const user = userEvent.setup();
    render(<App />);

    const example = await screen.findByRole('button', {
      name: /plan a relaxed afternoon in lagos tomorrow/i
    });
    await user.click(example);

    expect((screen.getByLabelText(/your request/i) as HTMLTextAreaElement).value).toBe(
      'Plan a relaxed afternoon in Lagos tomorrow.'
    );
  });

  it('disappears once there is a plan', async () => {
    render(<App />);
    expect(screen.getByText(/what's the plan/i)).toBeDefined();

    await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(document.querySelector('.itinerary')).not.toBeNull());

    expect(screen.queryByText(/what's the plan/i)).toBeNull();
  });
});

describe('the execution panel reports retries honestly', () => {
  it('counts a retry only when the server said one happened', async () => {
    let emit: (event: unknown) => void = () => {};
    let release: (value: AgentResponse) => void = () => {};

    runPlanTrip.mockImplementation(
      (_t: unknown, _i: unknown, options: {onEvent?: (event: unknown) => void}) => {
        emit = options.onEvent ?? (() => {});
        return new Promise<AgentResponse>(resolve => (release = resolve));
      }
    );

    render(<App />);
    const user = await plan('Plan something.');
    await waitFor(() => expect(document.querySelector('.execution')).not.toBeNull());

    act(() => {
      // The workflow emits both: the stage the user sees, and the count.
      emit({
        type: 'stage_started',
        marker: 'plan-execution-event',
        stage: 'retry',
        timestamp: 'now'
      });
      emit({type: 'model_retry', marker: 'plan-execution-event', attempt: 1, timestamp: 'now'});
      emit({
        type: 'run_completed',
        marker: 'plan-execution-event',
        durationMs: 12000,
        timestamp: 'now'
      });
    });
    release(itineraryResponse);

    await waitFor(() => expect(screen.getByText(/1 retry/i)).toBeDefined());

    await user.click(screen.getByText(/planned in/i));
    await waitFor(() => expect(screen.getByText(/retrying/i)).toBeDefined());
  });

  it('says nothing about retries for a clean run', async () => {
    render(<App />);
    await plan('Plan me an afternoon in Lagos.');
    await waitFor(() => expect(document.querySelector('.itinerary')).not.toBeNull());

    expect(document.body.textContent).not.toMatch(/retry|retrying/i);
  });
});
