/**
 * Tag identifiers carry their source as an internal wire-format prefix
 * (opcua:, tensor:) that isn't meant to be user-facing — tensor: in particular
 * is TEVE's internal storage prefix (see dataRetrieval.ts / teveConfigService),
 * but the product name shown everywhere else is "TEVE". Used when labeling
 * generated PDF report charts so they read the same as the dashboard UI.
 *
 * Mirrors client/src/utils/tagDisplay.ts — client and server are separate
 * builds with no shared module, so this small pure function is duplicated
 * rather than pulled in cross-project.
 */
export function tagDisplayName(tagName: string): string {
  if (tagName.startsWith('opcua:')) {
    return tagName.replace('opcua:', 'OPC: ');
  }
  if (tagName.startsWith('tensor:')) {
    return tagName.replace('tensor:', 'TEVE: ');
  }
  return tagName;
}
