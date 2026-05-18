import React, { useEffect, useState, useRef } from 'react';
import { Shield, Check, Info, ChevronDown, X } from 'lucide-react';
import { cn } from '../../utils/cn';

interface QualityFilterProps {
  selectedQualities: number[];
  onChange: (qualities: number[]) => void;
  disabled?: boolean;
  className?: string;
}

export const QualityFilter: React.FC<QualityFilterProps> = ({
  selectedQualities = [0],
  onChange,
  disabled = false,
  className
}) => {
  const [qualityMeanings, setQualityMeanings] = useState<Record<number, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchQualityCodes = async () => {
      try {
        const response = await fetch(`${process.env.REACT_APP_API_URL || '/api'}/data/quality-codes`);
        if (response.ok) {
          const result = await response.json();
          if (result.success) {
            setQualityMeanings(result.data);
          }
        }
      } catch (error) {
        console.error('Failed to fetch quality codes:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchQualityCodes();
  }, []);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const toggleQuality = (code: number) => {
    const numCode = Number(code);
    if (selectedQualities.includes(numCode)) {
      onChange(selectedQualities.filter(q => q !== numCode));
    } else {
      onChange([...selectedQualities, numCode]);
    }
  };

  const selectAll = () => {
    onChange(Object.keys(qualityMeanings).map(Number));
  };

  const selectGoodOnly = () => {
    onChange([0]); // QualityCode.Good is 0
  };

  const getActiveLabel = () => {
    if (isLoading) return 'Loading...';
    if (selectedQualities.length === 0) return 'None selected';
    if (selectedQualities.length === 1 && selectedQualities[0] === 0) return 'Good Only';
    if (selectedQualities.length === Object.keys(qualityMeanings).length) return 'All Qualities';
    return `${selectedQualities.length} qualities selected`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center space-x-2 text-sm text-gray-500 animate-pulse py-2">
        <div className="w-4 h-4 bg-gray-200 rounded-full" />
        <span>Loading quality status options...</span>
      </div>
    );
  }

  return (
    <div className={cn("relative w-full", className)} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          "flex items-center justify-between w-full px-4 py-3 text-sm font-medium transition-all duration-200 rounded-lg border shadow-sm",
          disabled
            ? "bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed"
            : "bg-white text-gray-700 border-gray-300 hover:border-primary-400 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2",
          isOpen && "ring-2 ring-primary-500 border-primary-500 shadow-md bg-white"
        )}
      >
        <div className="flex items-center">
          <div className={cn(
            "p-1.5 rounded-md mr-3 transition-colors",
            isOpen ? "bg-primary-100 text-primary-600" : "bg-gray-100 text-gray-500"
          )}>
            <Shield className="w-4 h-4" />
          </div>
          <div className="flex flex-col items-start text-left">
            <span className="font-semibold">Quality Data Filter</span>
            <span className="text-[0.7rem] text-gray-500 font-normal">
              {getActiveLabel()}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!disabled && selectedQualities.length > 0 && !isOpen && (
            <span className="flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-[0.65rem] font-bold bg-primary-600 text-white rounded-full">
              {selectedQualities.length}
            </span>
          )}
          <ChevronDown className={cn("w-4 h-4 text-gray-400 transition-transform duration-200", isOpen && "transform rotate-180 text-primary-500")} />
        </div>
      </button>

      {isOpen && (
        <div className="absolute left-0 z-50 w-full mt-2 origin-top-left bg-white border border-gray-200 rounded-xl shadow-2xl ring-1 ring-black ring-opacity-5 focus:outline-none overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          <div className="p-3 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="px-1 text-[0.65rem] font-bold text-gray-400 uppercase tracking-widest">Select Quality Levels</span>
              <div className="flex space-x-2">
                <button
                  type="button"
                  onClick={selectGoodOnly}
                  className="text-[9px] font-bold text-primary-600 hover:text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded border border-primary-100 transition-colors uppercase"
                >
                  Good Only
                </button>
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-[9px] font-bold text-gray-500 hover:text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200 transition-colors uppercase"
                >
                  All
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-1 hover:bg-gray-200 rounded-md transition-colors"
            >
              <X className="w-3.5 h-3.5 text-gray-500" />
            </button>
          </div>

          <div className="p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
              {Object.entries(qualityMeanings).map(([code, meaning]) => {
                const numCode = Number(code);
                const isSelected = selectedQualities.includes(numCode);
                const label = meaning.split(':')[0];
                const description = meaning.split(':')[1]?.trim() || '';

                return (
                  <div
                    key={code}
                    onClick={() => toggleQuality(numCode)}
                    className={cn(
                      "group relative flex flex-col p-2.5 rounded-lg border transition-all cursor-pointer",
                      isSelected
                        ? "border-primary-200 bg-primary-50 ring-1 ring-primary-100"
                        : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className={cn(
                        "text-xs font-bold",
                        isSelected ? "text-primary-700" : "text-gray-700"
                      )}>
                        {label}
                        <span className="ml-1 text-[10px] font-normal opacity-50">({code})</span>
                      </span>
                      {isSelected && (
                        <div className="bg-primary-600 rounded-full p-0.5">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                    </div>

                    <p className="text-[10px] text-gray-500 mt-1 line-clamp-1 group-hover:line-clamp-none transition-all">
                      {description}
                    </p>
                  </div>
                );
              })}
            </div>

            {selectedQualities.length === 0 && (
              <div className="flex items-start p-2.5 bg-amber-50 rounded-lg border border-amber-100">
                <Info className="w-3.5 h-3.5 text-amber-600 mr-2 mt-0.5 flex-shrink-0" />
                <p className="text-[10px] text-amber-800 leading-tight">
                  <strong>Warning:</strong> No quality codes selected. The report will contain NO data points.
                </p>
              </div>
            )}

            <div className="pt-1">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="w-full py-2 text-[0.7rem] font-bold text-primary-600 bg-primary-50 hover:bg-primary-100 rounded-lg transition-colors border border-primary-100 uppercase tracking-wider"
              >
                Apply Quality Filter
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
