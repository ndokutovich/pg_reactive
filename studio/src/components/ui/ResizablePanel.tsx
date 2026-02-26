import React, { useCallback, useRef, useState } from 'react';

interface ResizablePanelProps {
  top: React.ReactNode;
  bottom: React.ReactNode;
  defaultSplit?: number;
  className?: string;
}

export function ResizablePanel({
  top,
  bottom,
  defaultSplit = 60,
  className = '',
}: ResizablePanelProps): React.ReactElement {
  const [split, setSplit] = useState(defaultSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setSplit(Math.max(20, Math.min(80, pct)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return (
    <div ref={containerRef} className={`flex flex-col h-full min-h-0 ${className}`}>
      <div style={{ height: `${split}%` }} className="min-h-0 overflow-hidden">
        {top}
      </div>
      <div
        className="flex-shrink-0 h-1.5 bg-surface-200 hover:bg-brand cursor-row-resize transition-colors"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="horizontal"
      />
      <div style={{ height: `${100 - split}%` }} className="min-h-0 overflow-hidden">
        {bottom}
      </div>
    </div>
  );
}
