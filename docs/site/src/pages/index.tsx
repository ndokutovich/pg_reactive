import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="quickstart">
            Quick Start — 5 min
          </Link>
          <Link
            className="button button--outline button--secondary button--lg"
            style={{ marginLeft: '1rem' }}
            to="intro">
            What is pgStack?
          </Link>
        </div>
      </div>
    </header>
  );
}

type FeatureItem = {
  title: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Two containers. That is it.',
    description: (
      <>
        PostgreSQL + one proxy. No GoTrue, no PostgREST, no Realtime, no Kong, no Redis.
        Run <code>docker compose up -d</code> and your backend is ready — the proxy ships
        as two co-equal builds, <strong>Go or Rust</strong>, hardened to parity.
      </>
    ),
  },
  {
    title: 'Real-time SQL queries',
    description: (
      <>
        The <code>pg_reactive</code> C extension turns any SELECT into a live subscription.
        Delta delivery via WebSocket, column-level tracking, generation-isolated tenancy.
        No CDC, no polling — the database itself pushes the diff.
      </>
    ),
  },
  {
    title: 'Transaction batching',
    description: (
      <>
        Many writes, one transaction, one HTTP call: <code>POST /rest/v1/batch</code> with
        <code>{'{{op.field}}'}</code> templates, atomic or partial-success modes.
        The multi-statement transaction Supabase has never shipped.
      </>
    ),
  },
  {
    title: 'Edge Functions — five runtimes',
    description: (
      <>
        One <code>/functions/v1/</code> endpoint, five backends: embedded JS (goja),
        PL/v8, PL/Python, a Deno sidecar, or a per-function HTTP container in
        <em>any</em> language. Pick per function.
      </>
    ),
  },
  {
    title: 'PostgREST-compatible REST API',
    description: (
      <>
        Full CRUD with PostgREST filter syntax — <code>eq</code>, <code>gt</code>,
        <code>ilike</code>, <code>in</code>, FK embedding, RPC. Migrate from Supabase
        without changing client code.
      </>
    ),
  },
  {
    title: 'Security-first auth + RLS',
    description: (
      <>
        Email/password (argon2id), JWT, OAuth, magic links, refresh-token rotation.
        Row-Level Security on <em>every</em> request via a two-pool least-privilege
        model — hardened against 26 documented trust-boundary invariants.
      </>
    ),
  },
  {
    title: 'PostgreSQL-backed job queue',
    description: (
      <>
        Durable background jobs and cron scheduling with no Redis or RabbitMQ.
        Jobs are rows. Failures are retried. Observability is a <code>SELECT</code>.
      </>
    ),
  },
  {
    title: 'Studio + file storage',
    description: (
      <>
        A built-in admin Studio — table editor, SQL editor, auth users, live logs —
        plus S3-compatible storage buckets, PostgreSQL-backed by default
        (optional disk backend). All from the same two containers.
      </>
    ),
  },
  {
    title: 'TypeScript SDK + CLI',
    description: (
      <>
        Supabase-compatible <code>@pgstack/sdk</code> with React hooks.
        CLI for scaffolding, migrations, type generation, and dev environments.
      </>
    ),
  },
];

function Feature({ title, description }: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md padding-vert--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}

function WhyNotSupabase() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          <div className="col col--12 text--center">
            <Heading as="h2">Coming from Supabase?</Heading>
            <p>
              Same client code, a fraction of the moving parts — plus features Supabase
              doesn&apos;t have.
            </p>
          </div>
        </div>
        <div className="row">
          <div className="col col--4 padding-vert--md">
            <Heading as="h3">2 containers, not 15+</Heading>
            <p>
              GoTrue, PostgREST, Realtime, Storage, Kong, Redis — collapsed into one
              PostgreSQL and one proxy.
            </p>
          </div>
          <div className="col col--4 padding-vert--md">
            <Heading as="h3">Drop-in SDK</Heading>
            <p>
              The PostgREST filter syntax and <code>@pgstack/sdk</code> are
              Supabase-compatible. Point your client at a new URL.
            </p>
          </div>
          <div className="col col--4 padding-vert--md">
            <Heading as="h3">Things it never shipped</Heading>
            <p>
              Multi-statement transaction batching, database-native live queries, and
              five edge-function runtimes — out of the box.
            </p>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="button button--outline button--primary button--lg" to="vs-supabase">
            See the full comparison
          </Link>
        </div>
      </div>
    </section>
  );
}

function CodeExample() {
  return (
    <section className={styles.codeSection}>
      <div className="container">
        <div className="row">
          <div className="col col--12 text--center">
            <Heading as="h2">Get started in minutes</Heading>
          </div>
        </div>
        <div className="row">
          <div className="col col--6">
            <Heading as="h3">1. Start the stack</Heading>
            <pre className={styles.codeBlock}><code>{`npx pgstack init my-app
cd my-app
docker compose up -d`}</code></pre>
          </div>
          <div className="col col--6">
            <Heading as="h3">2. Query your data</Heading>
            <pre className={styles.codeBlock}><code>{`import { createClient } from '@pgstack/sdk';

const db = createClient(
  'http://127.0.0.1:8080',
  process.env.PGSTACK_ANON_KEY,
);

const { data } = await db.from('todos')
  .select('*')
  .eq('done', false)
  .order('created_at', { ascending: false });`}</code></pre>
          </div>
          <div className="col col--6">
            <Heading as="h3">3. Subscribe to live updates</Heading>
            <pre className={styles.codeBlock}><code>{`import { useLiveQuery } from '@pgstack/sdk/react';

function TodoList() {
  const { rows, state } = useLiveQuery('active_todos', {
    url: 'ws://127.0.0.1:8080',
    token: session.access_token,
  });
  return rows.map(r => <li>{String(r.title)}</li>);
}`}</code></pre>
          </div>
          <div className="col col--6">
            <Heading as="h3">4. Secure with RLS</Heading>
            <pre className={styles.codeBlock}><code>{`ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own todos"
  ON todos FOR ALL
  USING (user_id = auth.uid());

-- Every REST request runs as the
-- authenticated PostgreSQL role.
-- RLS is automatic.`}</code></pre>
          </div>
        </div>
        <div className="row" style={{ marginTop: '2rem', justifyContent: 'center' }}>
          <Link
            className="button button--primary button--lg"
            to="quickstart">
            Read the Quick Start Guide
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — PostgreSQL-native backend`}
      description="pgStack is a self-hosted Supabase alternative running in two Docker containers. Auth, REST API, live queries, and job queues — all powered by PostgreSQL.">
      <HomepageHeader />
      <main>
        <HomepageFeatures />
        <WhyNotSupabase />
        <CodeExample />
      </main>
    </Layout>
  );
}
