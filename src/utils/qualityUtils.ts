import { QualityCode } from '@/types/historian';

/**
 * Utility to map AVEVA Historian quality codes to human-readable meanings
 */
export const QUALITY_MEANINGS: Record<number, string> = {
  [QualityCode.Good]: 'Good: Standard valid and reliable data from the source.',
  [QualityCode.Bad]: 'Bad: Invalid data, typically due to communication or device failure.',
  [QualityCode.Uncertain]: 'Uncertain: Data quality is questionable or based on a last known value.',
  [QualityCode.InitialValue]: 'Good (Initial Value): The first good value at the start of the query period.',
  [QualityCode.OutOfSync]: 'Good (Out of Sync): Data received out of time sequence (common for cyclic tags).',
};

/**
 * Get the descriptive meaning for a quality code
 * @param code The numeric quality code
 * @returns A descriptive string
 */
export function getQualityMeaning(code: number): string {
  return QUALITY_MEANINGS[code] || `Unknown Quality (Code: ${code})`;
}

/**
 * Get the short label for a quality code
 * @param code The numeric quality code
 * @returns A short string (e.g., 'Good', 'Bad')
 */
export function getQualityLabel(code: number): string {
  if (code === QualityCode.Good || code === QualityCode.InitialValue || code === QualityCode.OutOfSync) return 'Good';
  if (code === QualityCode.Bad) return 'Bad';
  if (code === QualityCode.Uncertain) return 'Uncertain';
  
  // For others, use the enum key name if possible
  const entry = Object.entries(QualityCode).find(([_, val]) => val === code);
  return entry ? entry[0] : 'Unknown';
}
