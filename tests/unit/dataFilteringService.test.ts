/**
 * Unit Tests for Data Filtering Service (Maximum and Minimum Options)
 */

import { dataFilteringService } from '../../src/services/dataFiltering';
import { TimeSeriesData, QualityCode } from '../../src/types/historian';

describe('Data Filtering Service - Maximum and Minimum values', () => {
  const mockData: TimeSeriesData[] = [
    { timestamp: new Date('2026-01-01T00:00:00Z'), value: 10, quality: QualityCode.Good, tagName: 'Tag1' },
    { timestamp: new Date('2026-01-01T01:00:00Z'), value: 5, quality: QualityCode.Good, tagName: 'Tag1' }, // Min of Tag1
    { timestamp: new Date('2026-01-01T02:00:00Z'), value: 20, quality: QualityCode.Good, tagName: 'Tag1' }, // Max of Tag1
    { timestamp: new Date('2026-01-01T03:00:00Z'), value: 15, quality: QualityCode.Good, tagName: 'Tag1' },

    { timestamp: new Date('2026-01-01T00:00:00Z'), value: 100, quality: QualityCode.Good, tagName: 'Tag2' },
    { timestamp: new Date('2026-01-01T01:00:00Z'), value: 50, quality: QualityCode.Good, tagName: 'Tag2' }, // Min of Tag2
    { timestamp: new Date('2026-01-01T02:00:00Z'), value: 200, quality: QualityCode.Good, tagName: 'Tag2' }, // Max of Tag2
    { timestamp: new Date('2026-01-01T03:00:00Z'), value: 150, quality: QualityCode.Good, tagName: 'Tag2' }
  ];

  describe('IS_MAX Operator', () => {
    it('should correctly filter and return only the maximum values for each tag', () => {
      const filter = {
        advancedConditions: {
          comparison: {
            operator: 'IS_MAX' as any,
            value: 0 // value is ignored for unary operator
          }
        }
      };

      const result = dataFilteringService.applyFilters(mockData, filter);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag1', value: 20 }));
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag2', value: 200 }));
    });
  });

  describe('IS_MIN Operator', () => {
    it('should correctly filter and return only the minimum values for each tag', () => {
      const filter = {
        advancedConditions: {
          comparison: {
            operator: 'IS_MIN' as any,
            value: 0 // value is ignored for unary operator
          }
        }
      };

      const result = dataFilteringService.applyFilters(mockData, filter);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag1', value: 5 }));
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag2', value: 50 }));
    });
  });

  describe('Logical combinations with IS_MAX / IS_MIN', () => {
    it('should handle AND / OR groups containing IS_MAX or IS_MIN', () => {
      // Find points that are either IS_MIN OR have value > 100
      const filter = {
        advancedConditions: {
          logicalOperator: 'OR' as const,
          conditions: [
            {
              comparison: {
                operator: 'IS_MIN' as any,
                value: 0
              }
            },
            {
              comparison: {
                operator: 'GT' as const,
                value: 120
              }
            }
          ]
        }
      };

      const result = dataFilteringService.applyFilters(mockData, filter);

      // Should return:
      // - Tag1 Min (5)
      // - Tag2 Min (50)
      // - Tag2 Max (200) - since 200 > 120
      // - Tag2 at 03:00 (150) - since 150 > 120
      expect(result).toHaveLength(4);
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag1', value: 5 }));
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag2', value: 50 }));
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag2', value: 200 }));
      expect(result).toContainEqual(expect.objectContaining({ tagName: 'Tag2', value: 150 }));
    });
  });

  describe('Validation of Unary Operators', () => {
    it('should validate filter configurations without requiring comparison values for IS_MAX and IS_MIN', () => {
      const validMaxFilter = {
        advancedConditions: {
          comparison: {
            operator: 'IS_MAX' as any,
            value: undefined as any // Should be allowed for IS_MAX
          }
        }
      };

      const validMinFilter = {
        advancedConditions: {
          comparison: {
            operator: 'IS_MIN' as any,
            value: undefined as any // Should be allowed for IS_MIN
          }
        }
      };

      expect(() => dataFilteringService.validateFilter(validMaxFilter)).not.toThrow();
      expect(() => dataFilteringService.validateFilter(validMinFilter)).not.toThrow();
    });

    it('should still reject missing values for binary operators like GT', () => {
      const invalidFilter = {
        advancedConditions: {
          comparison: {
            operator: 'GT' as const,
            value: undefined as any // Should NOT be allowed for GT
          }
        }
      };

      expect(() => dataFilteringService.validateFilter(invalidFilter)).toThrow(/Comparison condition must have a valid numeric value/);
    });
  });

  describe('Handling NaN and Bad quality points', () => {
    it('should ignore NaN values when computing limits for IS_MAX or IS_MIN', () => {
      const dataWithNaN: TimeSeriesData[] = [
        { timestamp: new Date('2026-01-01T00:00:00Z'), value: NaN, quality: QualityCode.Bad, tagName: 'Tag1' },
        { timestamp: new Date('2026-01-01T01:00:00Z'), value: 5, quality: QualityCode.Good, tagName: 'Tag1' }, // Min of Tag1
        { timestamp: new Date('2026-01-01T02:00:00Z'), value: 20, quality: QualityCode.Good, tagName: 'Tag1' }, // Max of Tag1
        { timestamp: new Date('2026-01-01T03:00:00Z'), value: 15, quality: QualityCode.Good, tagName: 'Tag1' }
      ];

      const filter = {
        advancedConditions: {
          comparison: {
            operator: 'IS_MAX' as any,
            value: 0
          }
        }
      };

      const result = dataFilteringService.applyFilters(dataWithNaN, filter);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ tagName: 'Tag1', value: 20 }));
    });
  });
});
