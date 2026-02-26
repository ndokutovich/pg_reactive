import React from 'react';
import { Spinner } from './Spinner';

type ButtonVariant = 'primary' | 'secondary' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-brand hover:bg-brand-dark text-black font-semibold disabled:opacity-50',
  secondary:
    'bg-surface-200 hover:bg-surface-300 text-white border border-surface-300 disabled:opacity-50',
  danger:
    'bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-50',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-sm rounded',
  md: 'px-4 py-2 text-sm rounded-md',
  lg: 'px-5 py-2.5 text-base rounded-md',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps): React.ReactElement {
  return (
    <button
      {...props}
      disabled={disabled ?? loading}
      className={`inline-flex items-center gap-2 transition-colors cursor-pointer ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}
