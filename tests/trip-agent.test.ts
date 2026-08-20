import {describe, it, expect, afterEach} from 'vitest';

import {ItinerarySchema} from '../src/mastra/schemas/itinerary.js';
import {TRIP_AGENT_MODEL, createTripAgent, tripAgent} from '../src/mastra/agents/trip-agent.js';
import {getWeatherTool} from '../src/mastra/tools/get-weather.js';
import {findActivitiesTool} from '../src/mastra/tools/find-activities.js';
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
    textStep(JSON.stringify(ITINERARY_JSON))
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

  it('exposes both tools under their tool ids', async () => {
    const tools = await tripAgent.listTools();

    expect(Object.keys(tools).sort()).toEqual(['find-activities', 'get-weather']);
    expect(tools['get-weather']).toBe(getWeatherTool);
    expect(tools['find-activities']).toBe(findActivitiesTool);
  });

  it('uses ItinerarySchema for structured output', async () => {
    const defaults = await tripAgent.getDefaultOptions();

    expect(defaults.structuredOutput?.schema).toBe(ItinerarySchema);
  });

  it('configures a model for structured output so tools and schema can coexist', async () => {
    const defaults = await tripAgent.getDefaultOptions();

    expect(defaults.structuredOutput?.model).toBeDefined();
  });

  it('has instructions that direct it to the tools', async () => {
    const instructions = await tripAgent.getInstructions();
    const text = JSON.stringify(instructions);

    expect(text).toContain('get-weather');
    expect(text).toContain('find-activities');
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

    expect(ItinerarySchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.destination).toBe('Lagos');
    expect(result.object?.activities).toHaveLength(2);
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
    expect(offered).toEqual(['find-activities', 'get-weather']);
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
