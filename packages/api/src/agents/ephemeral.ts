import { ArtifactModes } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import { OFFICE_TOOL_NAMES } from '~/tools/toolkits/office';

/**
 * Office tools are on in every plain chat and the model offers a file when the
 * answer suits one. Only a model spec turns them off (`office: false`); the
 * client flag is ignored, so a switch left off before it was removed cannot
 * hide them.
 */
export function ephemeralOfficeTools(
  modelSpec: Pick<TModelSpec, 'office'> | null | undefined,
): readonly string[] {
  return modelSpec?.office === false ? [] : OFFICE_TOOL_NAMES;
}

/**
 * Artifacts in a plain chat come from the model spec only: the chat has no
 * switch for them, and a mode the client stored earlier must not keep the
 * artifacts prompt on with no way to turn it off.
 */
export function ephemeralArtifacts(
  modelSpec: Pick<TModelSpec, 'artifacts'> | null | undefined,
): string | undefined {
  const mode = modelSpec?.artifacts;
  if (mode === true) {
    return ArtifactModes.DEFAULT;
  }
  return typeof mode === 'string' && mode ? mode : undefined;
}
