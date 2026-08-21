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
const fetchConversations = vi.fn();
const fetchConversation = vi.fn();

vi.mock('../src/app/lib/mastra-client', async () => {
  const actual = await vi.importActual<typeof import('../src/app/lib/mastra-client')>(
    '../src/app/lib/mastra-client'
  );
  return {
    ...actual,
    runPlanTrip: (...args: unknown[]) => runPlanTrip(...args),
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
    messages: []
  });
  localStorage.clear();
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
    await waitFor(() => expect(screen.getByText(/no conversations yet/i)).toBeDefined());
  });

  it('loads the conversation the user clicks', async () => {
    fetchConversations.mockResolvedValue({conversations: CONVERSATIONS});
    fetchConversation.mockResolvedValue({...CONVERSATIONS[1], messages: []});

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
    fetchConversation.mockResolvedValue({...CONVERSATIONS[0], messages: []});

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

    const panelNew = screen.getByRole('button', {name: /\+ new conversation/i});
    await user.click(panelNew);

    await waitFor(() => expect(screen.getByText(/nothing planned yet/i)).toBeDefined());
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
  it('prompts for a key when neither a session nor a server key exists', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', {name: /AI: OpenAI/i})).toBeDefined());
    expect(screen.getByRole('button', {name: /add api key/i})).toBeDefined();
  });

  it('reports a server-configured key without revealing it', async () => {
    fetchIdentity.mockResolvedValue({
      ...IDENTITY,
      ai: {provider: 'openai', keySource: 'server'}
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/server configured/i)).toBeDefined());
    expect(document.body.textContent).not.toMatch(/sk-/);
  });

  it('accepts a key, masks it, and sends it as a header value never shown on screen', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /AI: OpenAI/i}));
    const input = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(input.type).toBe('password');

    await user.type(input, 'sk-my-secret-test-key');
    await user.click(screen.getByRole('button', {name: /save key/i}));

    await waitFor(() => expect(screen.getByText(/using your key/i)).toBeDefined());
    // The key is never rendered back to the page.
    expect(document.body.textContent).not.toContain('sk-my-secret-test-key');

    await plan('Plan me a day.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());

    // Passed as the third argument (the header value), not inside the body.
    const call = runPlanTrip.mock.calls.at(-1) as [string, Record<string, unknown>, string];
    expect(call[2]).toBe('sk-my-secret-test-key');
    expect(JSON.stringify(call[1])).not.toContain('sk-my-secret-test-key');
  });

  it('never writes the key to browser storage', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', {name: /AI: OpenAI/i}));
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

    await user.click(await screen.findByRole('button', {name: /AI: OpenAI/i}));
    await user.type(screen.getByLabelText(/api key/i), 'sk-to-be-cleared');
    await user.click(screen.getByRole('button', {name: /save key/i}));
    await waitFor(() => expect(screen.getByText(/using your key/i)).toBeDefined());

    await user.click(screen.getByRole('button', {name: /AI: OpenAI/i}));
    await user.click(screen.getByRole('button', {name: /clear key/i}));
    await waitFor(() => expect(screen.getByRole('button', {name: /add api key/i})).toBeDefined());

    await plan('Plan me a day.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalled());
    const call = runPlanTrip.mock.calls.at(-1) as [string, unknown, string | undefined];
    expect(call[2]).toBeUndefined();
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

    const composerNew = document.querySelector('.actions .btn.ghost') as HTMLButtonElement;
    expect(composerNew).not.toBeNull();
    await user.click(composerNew);
    await waitFor(() => expect(screen.getByText(/nothing planned yet/i)).toBeDefined());

    await plan('Plan me a morning in Lisbon.');
    await waitFor(() => expect(runPlanTrip).toHaveBeenCalledTimes(2));

    const first = (runPlanTrip.mock.calls[0] as [string, {threadId: string}])[1].threadId;
    const second = (runPlanTrip.mock.calls[1] as [string, {threadId: string}])[1].threadId;
    expect(second).not.toBe(first);
  });
});
