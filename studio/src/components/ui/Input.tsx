import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className = '', ...props }: InputProps): React.ReactElement {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-300 mb-1">
          {label}
        </label>
      )}
      <input
        {...props}
        className={`w-full bg-surface-100 border ${
          error ? 'border-red-500' : 'border-surface-300'
        } text-white rounded-md px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand transition-colors ${className}`}
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
