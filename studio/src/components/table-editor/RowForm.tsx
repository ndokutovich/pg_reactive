import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import type { ColumnDef } from '../../api/catalog';

interface RowFormProps {
  columns: ColumnDef[];
  initialData?: Record<string, unknown>;
  mode: 'insert' | 'edit';
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

function isSerialLike(col: ColumnDef): boolean {
  return (
    col.type === 'serial' ||
    col.type === 'bigserial' ||
    col.type === 'smallserial' ||
    (col.pk && col.default !== null && /nextval/i.test(col.default))
  );
}

export function RowForm({ columns, initialData, mode, onSubmit, onClose }: RowFormProps): React.ReactElement {
  const editableColumns = columns.filter((c) => {
    if (mode === 'insert' && isSerialLike(c)) return false;
    return true;
  });

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const col of editableColumns) {
      const val = initialData?.[col.name];
      init[col.name] =
        val === null || val === undefined
          ? ''
          : typeof val === 'object'
          ? JSON.stringify(val, null, 2)
          : String(val);
    }
    return init;
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data: Record<string, unknown> = {};
      for (const col of editableColumns) {
        const raw = values[col.name] ?? '';
        if (raw === '' && col.nullable) {
          data[col.name] = null;
        } else {
          data[col.name] = raw;
        }
      }
      await onSubmit(data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  function renderInput(col: ColumnDef): React.ReactElement {
    const val = values[col.name] ?? '';
    const baseClass =
      'w-full bg-surface-200 border border-surface-300 text-white rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand';

    const type = col.type.toLowerCase();

    if (type === 'bool' || type === 'boolean') {
      return (
        <input
          type="checkbox"
          checked={val === 'true' || val === 't'}
          onChange={(e) =>
            setValues((prev) => ({ ...prev, [col.name]: e.target.checked ? 'true' : 'false' }))
          }
          className="w-4 h-4 accent-brand"
        />
      );
    }

    if (['int2', 'int4', 'int8', 'integer', 'bigint', 'numeric', 'float4', 'float8', 'decimal'].includes(type)) {
      return (
        <input
          type="number"
          value={val}
          onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
          className={baseClass}
        />
      );
    }

    if (type === 'json' || type === 'jsonb') {
      return (
        <textarea
          value={val}
          onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
          rows={4}
          className={`${baseClass} font-mono text-xs resize-y`}
          placeholder="{}"
        />
      );
    }

    return (
      <input
        type="text"
        value={val}
        onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
        className={baseClass}
        placeholder={type.includes('timestamp') || type === 'date' ? '2024-01-01 00:00:00' : undefined}
      />
    );
  }

  return (
    <Modal
      title={mode === 'insert' ? 'Insert Row' : 'Edit Row'}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
        {editableColumns.map((col) => (
          <div key={col.name}>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {col.name}
              <span className="ml-1 text-gray-600 font-normal">{col.type}</span>
              {col.pk && <span className="ml-1 text-brand text-[10px]">PK</span>}
              {col.nullable && <span className="ml-1 text-gray-600 text-[10px]">nullable</span>}
            </label>
            {renderInput(col)}
          </div>
        ))}
        {error && (
          <div className="p-2 bg-red-900/30 border border-red-700/50 rounded text-red-300 text-xs">
            {error}
          </div>
        )}
      </form>
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-surface-200">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={submitting} onClick={(e) => { void handleSubmit(e as unknown as React.FormEvent); }}>
          {mode === 'insert' ? 'Insert' : 'Save Changes'}
        </Button>
      </div>
    </Modal>
  );
}
