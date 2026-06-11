import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'pgStack',
  tagline: 'PostgreSQL-native backend. Zero extra containers.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: process.env.DOCS_URL || 'https://ndokutovich.github.io',
  baseUrl: process.env.DOCS_BASE_URL || '/pg_reactive/',

  organizationName: 'ndokutovich',
  projectName: 'pg_reactive',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
          editUrl: 'https://github.com/ndokutovich/pg_reactive/edit/master/docs/site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'reactive',
        path: 'pg-reactive',
        routeBasePath: 'pg-reactive',
        sidebarPath: './sidebars.reactive.ts',
        editUrl: 'https://github.com/ndokutovich/pg_reactive/edit/master/docs/site/',
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
    },
    navbar: {
      title: 'pgStack',
      logo: {
        alt: 'pgStack Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Platform',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'reactive',
          sidebarId: 'reactive',
          position: 'left',
          label: 'pg_reactive',
        },
        {
          href: 'https://github.com/ndokutovich/pg_reactive',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: 'intro',
            },
            {
              label: 'Quick Start',
              to: 'quickstart',
            },
            {
              label: 'API Reference',
              to: 'reference/api',
            },
          ],
        },
        {
          title: 'Features',
          items: [
            {
              label: 'Authentication',
              to: 'auth/overview',
            },
            {
              label: 'REST API',
              to: 'rest/overview',
            },
            {
              label: 'Live Queries',
              to: 'realtime/overview',
            },
          ],
        },
        {
          title: 'pg_reactive',
          items: [
            {
              label: 'The Extension',
              to: '/pg-reactive/',
            },
            {
              label: 'Install Standalone',
              to: '/pg-reactive/install',
            },
            {
              label: 'Subscribe API',
              to: '/pg-reactive/subscribe',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/ndokutovich/pg_reactive',
            },
            {
              label: 'Issues',
              href: 'https://github.com/ndokutovich/pg_reactive/issues',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} pgStack contributors. PostgreSQL License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'sql', 'rust', 'toml', 'yaml', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
