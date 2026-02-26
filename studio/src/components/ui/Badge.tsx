import React from 'react';

type BadgeVariant = 'green' | 'yellow' | 'red' | 'gray' | 'blue';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  green: 'bg-green-900/50 text-green-300 border-green-700/50',
  yellow: 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50',
  red: 'bg-red-900/50 text-red-300 border-red-700/50',
  gray: 'bg-gray-800/50 text-gray-400 border-gray-600/50',
  blue: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
};

export function Badge({ variant = 'gray', children, className = '' }: BadgeProps): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
