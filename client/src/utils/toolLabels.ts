import { Constants, splitToolCallName } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/**
 * Shared tool-name parsing + friendly-label mapping used by the main
 * tool-call UI and the subagent ticker. Centralized so the MCP
 * delimiter (`<tool>_mcp_<server>`) and native-tool short names read
 * consistently in every surface that renders tool lifecycle.
 */

/** Native tool id → translation key for a user-readable short name. */
export const TOOL_FRIENDLY_NAME_KEYS: Record<string, TranslationKeys> = {
  execute_code: 'com_ui_tool_name_code',
  run_tools_with_code: 'com_ui_tool_name_code',
  run_tools_with_bash: 'com_ui_tool_name_code',
  bash_tool: 'com_ui_tool_name_code',
  web_search: 'com_ui_tool_name_web_search',
  image_gen_oai: 'com_ui_tool_name_image_gen',
  image_edit_oai: 'com_ui_tool_name_image_edit',
  gemini_image_gen: 'com_ui_tool_name_image_gen',
  file_search: 'com_ui_tool_name_file_search',
  code_interpreter: 'com_ui_tool_name_code_analysis',
  retrieval: 'com_ui_tool_name_file_search',
  ask_user_question: 'com_ui_tool_name_ask_user_question',
  create_file: 'com_ui_tool_name_create_file',
  set_memory: 'com_ui_tool_name_set_memory',
  edit_file: 'com_ui_tool_name_edit_file',
  delete_memory: 'com_ui_tool_name_delete_memory',
  skill: 'com_ui_skill',
  read_file: 'com_ui_tool_name_read_file',
  dochub: 'com_ui_tool_name_dochub',
  dochub_list: 'com_ui_tool_name_dochub_list',
  dochub_search: 'com_ui_tool_name_dochub_search',
  dochub_read: 'com_ui_tool_name_dochub_read',
  dochub_extract: 'com_ui_tool_name_dochub_extract',
  dochub_survey: 'com_ui_tool_name_dochub_survey',
  dochub_agent_list: 'com_ui_tool_name_dochub_list',
  dochub_agent_search: 'com_ui_tool_name_dochub_search',
  dochub_agent_read: 'com_ui_tool_name_dochub_read',
};

export interface ParsedToolName {
  /** Original tool id (unchanged). */
  raw: string;
  /** MCP server name when the tool follows `<tool>_mcp_<server>`, else `''`. */
  mcpServer: string;
  /** Tool-specific name — the `<tool>` half of an MCP id, or the raw
   *  name for native tools. Useful as the "action" label shown in a
   *  code-style badge next to the server name. */
  toolName: string;
  /** Translation key for a user-friendly display name, when the raw
   *  name matches a built-in native tool (web_search, execute_code, …).
   *  Absent for MCP tools and unknown names. */
  friendlyKey?: TranslationKeys;
}

/**
 * Split an incoming tool id into its constituent parts:
 *
 *   - `search_code_mcp_github` → `{ mcpServer: 'github', toolName: 'search_code' }`
 *   - `web_search`             → `{ mcpServer: '', toolName: 'web_search', friendlyKey: 'com_ui_tool_name_web_search' }`
 *   - `some_custom_tool`       → `{ mcpServer: '', toolName: 'some_custom_tool' }`
 */
export function parseToolName(
  rawName: string,
  knownServerNames?: readonly string[],
): ParsedToolName {
  if (rawName.includes(Constants.mcp_delimiter)) {
    const [toolName, mcpServer = ''] = splitToolCallName(rawName, knownServerNames);
    return { raw: rawName, mcpServer, toolName };
  }
  const friendlyKey = TOOL_FRIENDLY_NAME_KEYS[rawName];
  return {
    raw: rawName,
    mcpServer: '',
    toolName: rawName,
    ...(friendlyKey ? { friendlyKey } : {}),
  };
}

/**
 * Resolve a tool id to a single user-facing short label. Pure string —
 * use `parseToolName` directly when you need structured parts (e.g. to
 * render a code-style badge for the tool name next to the server).
 *
 *   - MCP tool  → server name (keeps the header summary short)
 *   - Native   → localized friendly name from {@link TOOL_FRIENDLY_NAME_KEYS}
 *   - Unknown  → raw name
 */
export function getToolDisplayLabel(
  rawName: string,
  localize: (key: TranslationKeys) => string,
  knownServerNames?: readonly string[],
): string {
  const parsed = parseToolName(rawName, knownServerNames);
  if (parsed.mcpServer) return parsed.mcpServer;
  if (parsed.friendlyKey) return localize(parsed.friendlyKey);
  return parsed.toolName;
}

export interface ToolProgressLabels {
  running: string;
  finished: string;
}

/** Labels quoted from the call's own args stay one short line. */
const ARG_LABEL_MAX_CHARS = 80;

const DOCHUB_ARG_LABELS: Record<
  string,
  { arg: string; running: TranslationKeys; finished: TranslationKeys; seq?: boolean }
> = {
  dochub_search: {
    arg: 'query',
    running: 'com_ui_dochub_searching',
    finished: 'com_ui_dochub_search_done',
  },
  dochub_agent_search: {
    arg: 'query',
    running: 'com_ui_dochub_searching',
    finished: 'com_ui_dochub_search_done',
  },
  dochub_read: {
    arg: 'document',
    running: 'com_ui_dochub_reading',
    finished: 'com_ui_dochub_read_done',
    seq: true,
  },
  dochub_agent_read: {
    arg: 'document',
    running: 'com_ui_dochub_reading',
    finished: 'com_ui_dochub_read_done',
    seq: true,
  },
};

function readArg(args: string | Record<string, unknown> | undefined, key: string): string {
  if (args == null) {
    return '';
  }
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return '';
    }
  }
  if (parsed == null || typeof parsed !== 'object') {
    return '';
  }
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * What a DocHub search or read is doing, quoted from its args: «Ищу в
 * коллекции: «отпуск»», «Читаю документ №4». Undefined for other tools and
 * while the args are still streaming, so the generic label shows instead.
 */
export function getDochubProgressLabels(
  toolName: string,
  args: string | Record<string, unknown> | undefined,
  localize: (key: TranslationKeys, values?: Record<string, string>) => string,
): ToolProgressLabels | undefined {
  const spec = DOCHUB_ARG_LABELS[toolName];
  if (!spec) {
    return undefined;
  }
  const raw = readArg(args, spec.arg);
  if (!raw) {
    return undefined;
  }
  const clipped =
    raw.length > ARG_LABEL_MAX_CHARS ? `${raw.slice(0, ARG_LABEL_MAX_CHARS - 1)}…` : raw;
  const value = spec.seq === true && /^\d+$/.test(clipped) ? `№${clipped}` : clipped;
  return {
    running: localize(spec.running, { 0: value }),
    finished: localize(spec.finished, { 0: value }),
  };
}
