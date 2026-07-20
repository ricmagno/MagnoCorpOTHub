/**
 * Tag identifiers carry their source as an internal wire-format prefix
 * (opcua:, tensor:) that isn't meant to be user-facing — tensor: in particular
 * is TEVE's internal storage prefix (see dataRetrieval.ts / teveConfigService on
 * the backend), but the product name shown everywhere else in the UI is "TEVE".
 * Centralized here so every place a tag name is rendered — tag pickers, chart
 * titles, legends, gauge labels — shows the same text instead of drifting
 * independently.
 */
export type TagSource = 'opcua' | 'tensor' | 'historian';

export function classifyTag(tagName: string): { displayName: string; source: TagSource } {
  if (tagName.startsWith('opcua:')) {
    return { displayName: tagName.replace('opcua:', 'OPC: '), source: 'opcua' };
  }
  if (tagName.startsWith('tensor:')) {
    return { displayName: tagName.replace('tensor:', 'TEVE: '), source: 'tensor' };
  }
  return { displayName: tagName, source: 'historian' };
}

export function tagDisplayName(tagName: string): string {
  return classifyTag(tagName).displayName;
}
