import React from 'react';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  label?: string;
}

export function Select({ options, label, className = '', ...props }: SelectProps): React.ReactElement {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-300 mb-1">
          {label}
        </label>
      )}
      <select
        {...props}
        className={`w-full bg-surface-100 border border-surface-300 text-white rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand transition-colors ${className}`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
