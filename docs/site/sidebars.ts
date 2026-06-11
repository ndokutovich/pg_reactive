import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      items: ['quickstart', 'installation', 'vs-supabase'],
    },
    {
      type: 'category',
      label: 'Authentication',
      items: [
        'auth/overview',
        'auth/email-password',
        'auth/oauth',
        'auth/magic-links',
        'auth/rls',
      ],
    },
    {
      type: 'category',
      label: 'REST API',
      items: [
        'rest/overview',
        'rest/filters',
        'rest/embedding',
        'rest/rpc',
        'rest/pagination',
        'rest/batch',
      ],
    },
    'realtime/overview',
    {
      type: 'category',
      label: 'Studio',
      items: [
        'studio/overview',
        'studio/table-editor',
        'studio/sql-editor',
      ],
    },
    {
      type: 'category',
      label: 'Edge Functions',
      items: [
        'functions/overview',
        'functions/deno',
        'functions/plv8',
        'functions/http',
      ],
    },
    {
      type: 'category',
      label: 'CLI',
      items: [
        'cli/overview',
        'cli/init',
        'cli/dev',
        'cli/migrations',
        'cli/generate',
        'cli/db-branching',
      ],
    },
    {
      type: 'category',
      label: 'DBOS Integration',
      items: [
        'dbos/overview',
        'dbos/job-queue',
        'dbos/scheduler',
      ],
    },
    {
      type: 'category',
      label: 'Self-Hosting',
      items: [
        'deploy/docker',
        'deploy/env-vars',
        'deploy/production',
      ],
    },
    'reference/api',
  ],
};

export default sidebars;
