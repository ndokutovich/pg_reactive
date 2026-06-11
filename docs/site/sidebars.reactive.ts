import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

/**
 * Sidebar for the standalone pg_reactive extension docs (Docusaurus
 * "reactive" plugin instance, served under /pg-reactive). The pgStack
 * platform docs live in the default instance with sidebars.ts.
 */
const sidebars: SidebarsConfig = {
  reactive: [
    'overview',
    {
      type: 'category',
      label: 'Getting Started',
      items: ['install', 'subscribe', 'query-support'],
    },
    {
      type: 'category',
      label: 'Protocol',
      items: ['wire-format', 'gucs', 'security-model'],
    },
    {
      type: 'category',
      label: 'Clients',
      items: ['proxy', 'sdk', 'react'],
    },
    {
      type: 'category',
      label: 'Internals',
      items: ['architecture'],
    },
  ],
};

export default sidebars;
