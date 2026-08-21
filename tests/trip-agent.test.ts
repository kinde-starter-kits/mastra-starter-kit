import {describe, it, expect, afterEach, vi} from 'vitest';

import {ItinerarySchema} from '../src/mastra/schemas/itinerary.js';
import {AgentResponseSchema} from '../src/mastra/schemas/agent-response.js';
import {TRIP_AGENT_MODEL, createTripAgent, todayIso, tripAgent} from '../src/mastra/agents/trip-agent.js';
import {getWeatherTool} from '../src/mastra/tools/get-weather.js';
import {findActivitiesTool} from '../src/mastra/tools/find-activities.js';
import {saveItineraryTool} from '../src/mastra/tools/save-itinerary.js';
import {listItinerariesTool} from '../src/mastra/tools/list-itineraries.js';
import {
  LAGOS_GEOCODING,
  forecast,
  installFetchMock,
  isGeocoding,
  json,
  restoreFetch
} from './helpers/open-meteo-mock.js';
import {scriptedModel, textStep, toolCallStep} from './helpers/scripted-model.js';

const DATE = '2026-08-22';

/** Open-Meteo is mocked, so the weather tool runs for real without a network. */
function mockWeatherApi(overrides?: Parameters<typeof forecast>[1]) {
  installFetchMock(url =>
    isGeocoding(url) ? json(LAGOS_GEOCODING) : json(forecast(DATE, overrides))
  );
}

/** A complete itinerary the scripted structuring pass can return. */
const ITINERARY_JSON = {
  destination: 'Lagos',
  date: DATE,
  summary: 'A relaxed afternoon indoors and out, arranged around the afternoon showers.',
  weather: {
    summary: 'Moderate drizzle',
    highCelsius: 27.2,
    lowCelsius: 24.8,
    precipitationChance: 100,
    considerations: ['Rain is likely, so the indoor stop is scheduled for the wettest hours']
  },
  activities: [
    {
      order: 1,
      name: 'Nike Art Gallery',
      category: 'culture',
      startTime: '14:00',
      durationMinutes: 90,
      location: 'Lekki, Lagos',
      description: 'Browse five floors of Nigerian painting, sculpture and textiles.',
      weatherDependent: false
    },
    {
      order: 2,
      name: 'Dinner at Yellow Chilli',
      category: 'food',
      startTime: '16:30',
      durationMinutes: 90,
      location: 'Victoria Island, Lagos',
      description: 'Modern Nigerian cooking in a relaxed dining room.',
      weatherDependent: false
    }
  ],
  notes: ['Carry a light rain jacket between stops']
};

/**
 * Drive the agent through the full sequence: weather tool, activities tool,
 * then the structured-output pass. Four model turns are scripted because the
 * structuring agent is a separate model call.
 */
function planningAgent(activityArgs: Record<string, unknown>) {
  const model = scriptedModel([
    toolCallStep('get-weather', {location: 'Lagos', date: DATE}),
    toolCallStep('find-activities', activityArgs),
    textStep('Here is your afternoon in Lagos.'),
    textStep(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY_JSON}))
  ]);

  return {model, agent: createTripAgent({model})};
}

afterEach(() => {
  restoreFetch();
});

describe('registration and configuration', () => {
  it('is constructible and carries a stable id and name', () => {
    expect(tripAgent.id).toBe('trip-agent');
    expect(tripAgent.name).toBe('Trip Agent');
  });

  it('is registered with the Mastra instance', async () => {
    process.env.KINDE_DOMAIN ??= 'https://example.kinde.com';
    process.env.DATABASE_URL ??= ':memory:';
    const {mastra} = await import('../src/mastra/index.js');

    expect(mastra.getAgent('tripAgent')).toBeDefined();
    expect(mastra.getAgent('tripAgent').id).toBe('trip-agent');
  });

  it('uses a single configured model from the Mastra gateway', () => {
    expect(TRIP_AGENT_MODEL).toBe('openai/gpt-4.1-mini');
  });

  it('exposes the planning and persistence tools under their tool ids', async () => {
    const tools = await tripAgent.listTools();

    expect(Object.keys(tools).sort()).toEqual([
      'find-activities',
      'get-weather',
      'list-itineraries',
      'save-itinerary'
    ]);
    expect(tools['get-weather']).toBe(getWeatherTool);
    expect(tools['find-activities']).toBe(findActivitiesTool);
    expect(tools['save-itinerary']).toBe(saveItineraryTool);
    expect(tools['list-itineraries']).toBe(listItinerariesTool);
  });

  it('uses the AgentResponse envelope for structured output', async () => {
    // The production agent resolves its model per request, so a key must be
    // available for defaults to resolve at all.
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-placeholder';
    try {
      const defaults = await tripAgent.getDefaultOptions();
      expect(defaults.structuredOutput?.schema).toBe(AgentResponseSchema);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('refuses to resolve a model when no key is available', async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const error = await Promise.resolve()
        .then(() => tripAgent.getDefaultOptions())
        .then(
          () => null,
          (caught: unknown) => caught as {code?: string; message?: string}
        );

      expect(error?.code).toBe('model_key_missing');
      // The message tells the user what to do and contains no key material.
      expect(error?.message).toMatch(/Add your own key|OPENAI_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it('injects the schema into the prompt, which the discriminated union requires', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-placeholder';
    try {
      const defaults = await tripAgent.getDefaultOptions();
      // Without this, OpenAI's native structured-output mode cannot express a
      // root-level oneOf and Mastra silently returns object: null.
      expect(defaults.structuredOutput?.jsonPromptInjection).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('configures a model for structured output so tools and schema can coexist', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-placeholder';
    try {
      const defaults = await tripAgent.getDefaultOptions();
      expect(defaults.structuredOutput?.model).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('has instructions that direct it to the tools', async () => {
    const instructions = await tripAgent.getInstructions();
    const text = JSON.stringify(instructions);

    expect(text).toContain('get-weather');
    expect(text).toContain('find-activities');
  });
});

describe('date handling', () => {
  it("tells the agent today's date so relative dates are not guessed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T09:00:00Z'));

    try {
      const instructions = JSON.stringify(await tripAgent.getInstructions());
      expect(instructions).toContain("Today's date is 2026-08-21");
      expect(instructions).toMatch(/never against your own assumption of the date/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recomputes the date per request rather than freezing it at import', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
      const first = JSON.stringify(await tripAgent.getInstructions());

      vi.setSystemTime(new Date('2027-03-04T00:00:00Z'));
      const second = JSON.stringify(await tripAgent.getInstructions());

      expect(first).toContain('2026-01-02');
      expect(second).toContain('2027-03-04');
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats the date as the YYYY-MM-DD the tools expect', () => {
    expect(todayIso(new Date('2026-08-21T23:30:00Z'))).toBe('2026-08-21');
  });
});

describe('planning run', () => {
  it('calls the weather tool, then the activity tool, then returns an itinerary', async () => {
    mockWeatherApi();
    const {agent} = planningAgent({
      location: 'Lagos',
      date: DATE,
      tags: ['outdoors'],
      weather: {precipitationChance: 100, highCelsius: 27.2, lowCelsius: 24.8}
    });

    const result = await agent.generate(
      'Plan me an afternoon in Lagos tomorrow. I like outdoor activities and nothing too early.'
    );

    const toolNames = (result.toolCalls ?? []).map(call => call.payload.toolName);
    expect(toolNames).toEqual(['get-weather', 'find-activities']);
  });

  it('returns an object that validates against ItinerarySchema', async () => {
    mockWeatherApi();
    const {agent} = planningAgent({location: 'Lagos', date: DATE});

    const result = await agent.generate('Plan me an afternoon in Lagos tomorrow.');

    expect(AgentResponseSchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.kind).toBe('itinerary');

    const itinerary = result.object?.kind === 'itinerary' ? result.object.itinerary : undefined;
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
    expect(itinerary?.destination).toBe('Lagos');
    expect(itinerary?.activities).toHaveLength(2);
  });

  it('runs the real weather tool and feeds its result back to the model', async () => {
    mockWeatherApi();
    const {model, agent} = planningAgent({location: 'Lagos', date: DATE});

    await agent.generate('Plan me an afternoon in Lagos tomorrow.');

    // The second model turn must have seen the weather tool's output.
    const secondTurn = JSON.stringify(model.doGenerateCalls[1]?.prompt ?? '');
    expect(secondTurn).toContain('Africa/Lagos');
    expect(secondTurn).toContain('Moderate drizzle');
  });

  it('runs the real activity tool and feeds its result back to the model', async () => {
    mockWeatherApi();
    const {model, agent} = planningAgent({
      location: 'Lagos',
      date: DATE,
      weather: {precipitationChance: 100, highCelsius: 27.2, lowCelsius: 24.8},
      limit: 5
    });

    await agent.generate('Plan me an afternoon in Lagos tomorrow.');

    // The third model turn must have seen candidate activities from the dataset.
    const thirdTurn = JSON.stringify(model.doGenerateCalls[2]?.prompt ?? '');
    expect(thirdTurn).toContain('Nike Art Gallery');
    // Rain was passed through, so the tool reports the wet condition.
    expect(thirdTurn).toContain('"condition":"wet"');
  });

  it('offers both tools to the model on the first turn', async () => {
    mockWeatherApi();
    const {model, agent} = planningAgent({location: 'Lagos', date: DATE});

    await agent.generate('Plan me an afternoon in Lagos tomorrow.');

    const offered = (model.doGenerateCalls[0]?.tools ?? []).map(tool => tool.name).sort();
    expect(offered).toEqual([
      'find-activities',
      'get-weather',
      'list-itineraries',
      'save-itinerary'
    ]);
  });

  it('surfaces the weather tool result in the run, not invented weather', async () => {
    mockWeatherApi({weatherCode: 0, high: 31, low: 22, precipitation: 5});
    const {agent} = planningAgent({location: 'Lagos', date: DATE});

    const result = await agent.generate('Plan me an afternoon in Lagos tomorrow.');

    const weatherCall = (result.toolCalls ?? []).find(
      call => call.payload.toolName === 'get-weather'
    );
    expect(weatherCall).toBeDefined();

    const weatherResult = (result.toolResults ?? []).find(
      entry => entry.payload.toolName === 'get-weather'
    );
    expect(weatherResult?.payload.result).toMatchObject({
      summary: 'Clear sky',
      highCelsius: 31,
      precipitationChance: 5
    });
  });
});
