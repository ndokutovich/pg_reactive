import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
}

export function SqlEditor({ value, onChange, onRun }: SqlEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        sql({ dialect: PostgreSQL }),
        oneDark,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
          {
            key: 'Ctrl-Enter',
            run: () => {
              onRunRef.current();
              return true;
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              onRunRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: '#1c1c1c' },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: '13px',
          },
          '.cm-gutters': {
            backgroundColor: '#1c1c1c',
            borderRight: '1px solid #333333',
          },
          '.cm-activeLineGutter': { backgroundColor: '#2a2a2a' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
