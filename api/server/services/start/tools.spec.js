const os = require('os');
const fs = require('fs');
const path = require('path');
const { loadAndFormatTools } = require('./tools');

const DOCHUB_TOOLS = ['dochub', 'dochub_search', 'dochub_read', 'dochub_survey'];

describe('loadAndFormatTools — DocHub', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** The cache is what the agent builder and the model read, so it is the switch. */
  it('omits the DocHub tools unless the integration is configured', () => {
    const tools = loadAndFormatTools({ directory });

    for (const name of DOCHUB_TOOLS) {
      expect(tools).not.toHaveProperty(name);
    }
  });

  it('lists every DocHub tool when the integration is configured', () => {
    const tools = loadAndFormatTools({ directory, dochubEnabled: true });

    for (const name of DOCHUB_TOOLS) {
      expect(tools[name].function.name).toBe(name);
      expect(tools[name].function.parameters.type).toBe('object');
    }
    expect(tools.dochub_search.function.parameters.required).toEqual(['collection', 'query']);
  });

  it('lets the admin include the whole toolkit by its key', () => {
    const tools = loadAndFormatTools({ directory, dochubEnabled: true, adminIncluded: ['dochub'] });

    for (const name of DOCHUB_TOOLS) {
      expect(tools[name].function.name).toBe(name);
    }
    expect(tools).not.toHaveProperty('calculator');
  });

  it('lets the admin filter the whole toolkit by its key', () => {
    const tools = loadAndFormatTools({ directory, dochubEnabled: true, adminFilter: ['dochub'] });

    for (const name of DOCHUB_TOOLS) {
      expect(tools).not.toHaveProperty(name);
    }
  });
});

describe('loadAndFormatTools — create_presentation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('lists the presentation tool without any integration config', () => {
    const tools = loadAndFormatTools({ directory });

    expect(tools.create_presentation.function.name).toBe('create_presentation');
    expect(tools.create_presentation.function.parameters.required).toEqual(['title', 'slides']);
  });

  it('lets the admin filter it out', () => {
    const tools = loadAndFormatTools({ directory, adminFilter: ['create_presentation'] });

    expect(tools).not.toHaveProperty('create_presentation');
  });
});
