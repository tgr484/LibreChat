const { isBuiltInTool } = require('~/server/services/ToolService');

describe('isBuiltInTool — DocHub agents', () => {
  /** Without this the definitions path drops a DocHub agent's tools: they have no manifest entry. */
  it('treats the pinned DocHub agent tools as built in', () => {
    for (const name of ['dochub_agent_list', 'dochub_agent_search', 'dochub_agent_read']) {
      expect(isBuiltInTool(name)).toBe(true);
    }
  });

  it('keeps the toolkit key and rejects unknown names', () => {
    expect(isBuiltInTool('dochub')).toBe(true);
    expect(isBuiltInTool('dochub_agent_delete')).toBe(false);
  });
});
