/// <reference types="bun-types" />
/** Real temporary PostgreSQL: canonical Drizzle schema, actual RPCs and triggers.
 * Requires initdb/pg_ctl/psql on PATH (or INDEXING_TEST_PG_BIN).
 * Run: bun test src/db/indexing-state.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'ak-indexing-pg-'));
const pgBin = process.env.INDEXING_TEST_PG_BIN;
const bin = (name: string) => pgBin ? join(pgBin, name) : name;
// Never inherit a developer's PGHOSTADDR/PGSERVICE/PGUSER connection settings.
const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
const pgArgs = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', temp, '-p', '55482', '-U', userInfo().username, '-d', 'postgres'];
let started = false;
function command(args: string[], input?: string) {
  const result = Bun.spawnSync(args, { stdin: input === undefined ? undefined : Buffer.from(input), env: localEnv });
  const out = result.stdout.toString().trim();
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || out);
  return out;
}
const query = (sql: string) => command([bin('psql'), ...pgArgs], sql);
const ownerA = '00000000-0000-4000-8000-000000000001';
const ownerB = '00000000-0000-4000-8000-000000000002';
function acquire(owner = ownerA, chain = 'celo', path = 'transfers') {
  return query(`SET ROLE service_role; SELECT row_to_json(s) FROM public.acquire_indexing_lease('${chain}', '${path}', '${owner}', 60000, 300000, true) s;`);
}
function fenced(sql: string, owner = ownerA, role = 'service_role') {
  return query(`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL request.headers = '{"x-indexing-chain":"celo","x-indexing-path":"transfers","x-indexing-owner":"${owner}"}'; ${sql}; COMMIT;`);
}

function seedArchivedRows(sql: string) {
  const tables = ['wallets', 'transactions', 'signal_events', 'indexer_cursors', 'erc8004_agents', 'erc8004_feedback', 'scores', 'successions', 'feedback', 'organization_members', 'agent_manifests', 'bonds', 'bond_underwriters', 'celo_x402_payees'];
  query('BEGIN; ' + tables.map(table => `ALTER TABLE public.${table} DISABLE TRIGGER indexing_write_fence;`).join(' ')
    + sql + '; ' + tables.map(table => `ALTER TABLE public.${table} ENABLE TRIGGER indexing_write_fence;`).join(' ') + ' COMMIT;');
}

beforeAll(() => {
  command([bin('initdb'), '-D', join(temp, 'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  command([bin('pg_ctl'), '-D', join(temp, 'data'), '-l', join(temp, 'server.log'), '-o', `-k ${temp} -p 55482 -h ''`, '-w', 'start']);
  started = true;
  query('CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  const generated = join(temp, 'schema');
  command(['bun', 'drizzle-kit', 'generate', '--dialect=postgresql', `--schema=${resolve('src/db/schema.ts')}`, `--out=${generated}`, '--name=integration']);
  for (const file of readdirSync(generated).filter((file) => file.endsWith('.sql'))) {
    query(readFileSync(join(generated, file), 'utf8'));
  }
  query('GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;');
  // Missing foundation is a test failure, never a skipped integration test.
  query(readFileSync(resolve('src/db/sql/indexing-state.sql'), 'utf8'));
}, 30000);

afterAll(() => {
  if (started) command([bin('pg_ctl'), '-D', join(temp, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(temp, { recursive: true, force: true });
});

beforeEach(() => {
  query('TRUNCATE public.wallet_tx_stats, public.indexing_state, public.indexer_cursors, public.erc8004_agents, public.wallets, public.organizations, public.celo_x402_payees CASCADE;');
});

describe('persistent lease and success state', () => {
  test('settlement counters reject public writes without lease headers despite default grants', () => {
    // Reproduce Supabase public-schema defaults before applying the repeatable
    // hardening SQL; absent context must not bypass table authorization.
    query('GRANT ALL ON public.wallet_tx_stats TO anon, authenticated;');
    query(readFileSync(resolve('src/db/sql/indexing-state.sql'), 'utf8'));
    query("INSERT INTO public.indexing_state(chain,path,enabled,interval_ms) VALUES ('arc-mainnet','transfers',true,300000);");
    acquire(ownerA, 'arc-mainnet');
    query(`BEGIN; SET LOCAL ROLE service_role;
      SET LOCAL request.headers='{"x-indexing-chain":"arc-mainnet","x-indexing-path":"transfers","x-indexing-owner":"${ownerA}"}';
      INSERT INTO public.wallet_tx_stats(chain,address,settled_count,last_block)
      VALUES ('arc-mainnet','protected-counter',2,100); COMMIT;`);
    for (const role of ['anon', 'authenticated']) {
      expect(() => query(`SET ROLE ${role}; INSERT INTO public.wallet_tx_stats(chain,address,settled_count)
        VALUES ('arc-mainnet','injected-counter',99);`)).toThrow();
      expect(() => query(`SET ROLE ${role}; UPDATE public.wallet_tx_stats SET settled_count=99
        WHERE chain='arc-mainnet' AND address='protected-counter';`)).toThrow();
      expect(() => query(`SET ROLE ${role}; DELETE FROM public.wallet_tx_stats
        WHERE chain='arc-mainnet' AND address='protected-counter';`)).toThrow();
    }
    expect(query("SELECT settled_count FROM public.wallet_tx_stats WHERE address='protected-counter';")).toBe('2');
    expect(query("SELECT count(*) FROM public.wallet_tx_stats WHERE address='injected-counter';")).toBe('0');
  });

  test('Arc wallet receipt counters reject expired and wrong owners while accepting the live lease', () => {
    query("INSERT INTO public.indexing_state(chain,path,enabled,interval_ms) VALUES ('arc-mainnet','transfers',true,300000);");
    acquire(ownerA, 'arc-mainnet');
    const writeCounters = (owner: string, settled: number) => query(`BEGIN; SET LOCAL ROLE service_role;
      SET LOCAL request.headers='{"x-indexing-chain":"arc-mainnet","x-indexing-path":"transfers","x-indexing-owner":"${owner}"}';
      INSERT INTO public.wallet_tx_stats(chain,address,settled_count,failed_count,last_block)
      VALUES ('arc-mainnet','fenced-counter',${settled},0,100)
      ON CONFLICT(chain,address) DO UPDATE SET settled_count=EXCLUDED.settled_count; COMMIT;`);
    writeCounters(ownerA, 2);
    expect(query("SELECT settled_count FROM wallet_tx_stats WHERE chain='arc-mainnet' AND address='fenced-counter';")).toBe('2');
    expect(() => writeCounters(ownerB, 9)).toThrow('indexing_lease_lost');
    query("UPDATE indexing_state SET lease_until=clock_timestamp()-interval '1 second' WHERE chain='arc-mainnet';");
    expect(() => writeCounters(ownerA, 9)).toThrow('indexing_lease_lost');
    acquire(ownerB, 'arc-mainnet');
    writeCounters(ownerB, 3);
    expect(() => writeCounters(ownerA, 9)).toThrow('indexing_lease_lost');
    expect(query("SELECT settled_count FROM wallet_tx_stats WHERE chain='arc-mainnet' AND address='fenced-counter';")).toBe('3');
  });

  test('mainnet receipt keyset pages preserve tied PostgreSQL timestamps and isolate chains', () => {
    seedArchivedRows("INSERT INTO public.wallets(chain,address) VALUES ('arc-mainnet','page-wallet'),('arc','page-wallet');");
    seedArchivedRows(`INSERT INTO public.signal_events(id,chain,agent_wallet,tier,kind,observed_at)
      SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(n),12,'0'))::uuid,
        'arc-mainnet','page-wallet',2,'usdc_transfer_settled','2026-09-12T00:00:00.123456Z'
      FROM generate_series(1,1500) n;
      INSERT INTO public.signal_events(chain,agent_wallet,tier,kind,observed_at)
      VALUES ('arc','page-wallet',1,'usdc_transfer_settled','2026-09-13T00:00:00Z');`);
    const base = "FROM public.signal_events WHERE chain='arc-mainnet' AND agent_wallet='page-wallet' AND kind='usdc_transfer_settled'";
    const first = query(`SELECT id ${base} ORDER BY observed_at DESC,id DESC LIMIT 1000;`).split('\n');
    const cursor = first[first.length - 1];
    const second = query(`SELECT id ${base} AND (observed_at < '2026-09-12T00:00:00.123456Z'
      OR (observed_at='2026-09-12T00:00:00.123456Z' AND id < '${cursor}'))
      ORDER BY observed_at DESC,id DESC LIMIT 1000;`).split('\n');
    expect(first).toHaveLength(1000);
    expect(second).toHaveLength(500);
    expect(new Set([...first, ...second]).size).toBe(1500);
    expect(query(`SELECT id ${base} ORDER BY observed_at DESC,id DESC;`).split('\n')).toEqual([...first, ...second]);
  });
  test('missing Arc state stays disabled even when acquisition requests enablement', () => {
    expect(acquire(ownerA, 'arc-mainnet')).toBe('');
    const state = JSON.parse(query("SELECT row_to_json(s) FROM public.indexing_state s WHERE chain='arc-mainnet';"));
    expect(state.enabled).toBe(false);
    expect(state.owner).toBeNull();
    expect(state.lease_until).toBeNull();
    expect(state.last_attempt_at).toBeNull();
    expect(state.generation).toBe(0);
    expect(acquire(ownerB, 'arc-mainnet')).toBe('');
    // Deleting rollout state must not turn the next scheduled run into activation.
    query("DELETE FROM public.indexing_state WHERE chain='arc-mainnet';");
    expect(acquire(ownerB, 'arc-mainnet')).toBe('');
    expect(query("SELECT enabled FROM public.indexing_state WHERE chain='arc-mainnet';")).toBe('f');
  });

  test('Arc leases cannot collide with testnet ownership', () => {
    query("INSERT INTO public.indexing_state(chain,path,enabled,interval_ms) VALUES ('arc-mainnet','transfers',true,300000);");
    expect(acquire(ownerA, 'arc')).toBe('');
    expect(JSON.parse(acquire(ownerB, 'arc-mainnet')).owner).toBe(ownerB);
    expect(query('SELECT count(*) FROM public.indexing_state;')).toBe('2');
    const mainnetContext = `BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers='{"x-indexing-chain":"arc-mainnet","x-indexing-path":"transfers","x-indexing-owner":"${ownerB}"}';`;
    query(mainnetContext + "INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('arc-mainnet','rail','mainnet-tip'); COMMIT;");
    expect(() => query(mainnetContext + "INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('arc','rail','wrong-network'); COMMIT;")).toThrow('arc_testnet_retired');
    expect(query("SELECT chain || ':' || last_signature FROM public.indexer_cursors;")).toBe('arc-mainnet:mainnet-tip');
  });

  test('identical EVM addresses and raw transaction hashes persist independently on both networks', () => {
    const address = '0x1111111111111111111111111111111111111111';
    const hash = '0x' + 'ab'.repeat(32);
    seedArchivedRows(`INSERT INTO public.wallets(chain,address) VALUES ('arc','${address}'),('arc-mainnet','${address}');`);
    for (const chain of ['arc', 'arc-mainnet']) {
      seedArchivedRows(`INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('${chain}','${address}','rail',now(),'${hash}',1) ON CONFLICT(chain,tx_signature) DO NOTHING;`);
      seedArchivedRows(`INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('${chain}','${address}','rail',now(),'${hash}',99) ON CONFLICT(chain,tx_signature) DO NOTHING;`);
    }
    expect(query(`SELECT chain || ':' || amount::numeric::text FROM public.transactions WHERE tx_signature='${hash}' ORDER BY chain;`)).toBe('arc:1.000000000000000000\narc-mainnet:1.000000000000000000');
    expect(query(`SELECT count(DISTINCT id) FROM public.transactions WHERE tx_signature='${hash}';`)).toBe('2');
  });

  test('eighteen-decimal mainnet receipts and existing six-decimal amounts are stored exactly', () => {
    seedArchivedRows("INSERT INTO public.wallets(chain,address) VALUES ('arc','same-address'),('arc-mainnet','same-address');");
    seedArchivedRows("INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('arc','same-address','rail',now(),'old-six',1.234567),('arc-mainnet','same-address','rail',now(),'native-wei',0.000000000000000001);");
    expect(query("SELECT amount FROM public.transactions WHERE tx_signature='native-wei';")).toBe('0.000000000000000001');
    expect(query("SELECT amount FROM public.transactions WHERE tx_signature='old-six';")).toBe('1.234567000000000000');
  });

  test('expand-contract migration preserves old writers and rows while gating mainnet', () => {
    query(`CREATE SCHEMA rollout_check;
      CREATE TABLE rollout_check.transactions (LIKE public.transactions INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
      ALTER TABLE rollout_check.transactions ALTER COLUMN amount TYPE numeric(20,6);
      ALTER TABLE rollout_check.transactions ADD CONSTRAINT transactions_tx_signature_unique UNIQUE(tx_signature);
      CREATE TABLE rollout_check.indexing_state (LIKE public.indexing_state INCLUDING ALL);
      ALTER TABLE rollout_check.indexing_state DROP CONSTRAINT indexing_state_chain_check;
      ALTER TABLE rollout_check.indexing_state ADD CONSTRAINT indexing_state_chain_check CHECK(chain IN ('solana','arc','celo','stellar'));
      INSERT INTO rollout_check.transactions(id,chain,wallet_address,facilitator,timestamp,tx_signature,amount)
      VALUES ('${ownerA}','arc','same-address','rail',now(),'same-hash',1.234567);`);
    try {
      query('SET search_path=rollout_check,public; ' + readFileSync(resolve('drizzle/0019_arc_mainnet_expand.sql'), 'utf8'));
      expect(query("SELECT enabled FROM rollout_check.indexing_state WHERE chain='arc-mainnet';")).toBe('f');
      // Legacy deployed writers still find their old unique conflict target.
      query("INSERT INTO rollout_check.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('arc','same-address','rail',now(),'same-hash',99) ON CONFLICT(tx_signature) DO NOTHING;");
      // New writers can deploy before contraction but cannot yet ingest the
      // same mainnet hash; the independent disabled state prevents that rollout.
      expect(() => query("INSERT INTO rollout_check.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('arc-mainnet','same-address','rail',now(),'same-hash',0.000000000000000001) ON CONFLICT(chain,tx_signature) DO NOTHING;")).toThrow('duplicate key');
      query('SET search_path=rollout_check,public; ' + readFileSync(resolve('drizzle/0020_arc_mainnet_contract.sql'), 'utf8'));
      query("INSERT INTO rollout_check.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('arc-mainnet','same-address','rail',now(),'same-hash',0.000000000000000001) ON CONFLICT(chain,tx_signature) DO NOTHING;");
      expect(query("SELECT id || ':' || amount FROM rollout_check.transactions WHERE chain='arc';")).toBe(`${ownerA}:1.234567000000000000`);
      expect(query("SELECT amount FROM rollout_check.transactions WHERE chain='arc-mainnet';")).toBe('0.000000000000000001');
      expect(query("SELECT enabled FROM rollout_check.indexing_state WHERE chain='arc-mainnet';")).toBe('f');
    } finally { query('DROP SCHEMA rollout_check CASCADE;'); }
  });

  test('one owner per path, independent chains, fresh takeover generation', () => {
    expect(JSON.parse(acquire()).generation).toBe(1);
    expect(acquire(ownerB)).toBe('');
    expect(JSON.parse(acquire(ownerB, 'stellar')).owner).toBe(ownerB);
    query("UPDATE public.indexing_state SET lease_until = clock_timestamp() - interval '1 second' WHERE chain = 'celo';");
    expect(JSON.parse(acquire(ownerB)).generation).toBe(2);
    expect(query(`SET ROLE service_role; SELECT public.renew_indexing_lease('celo','transfers','${ownerA}',60000);`)).toBe('f');
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up');`)).toBe('f');
    expect(query("SELECT owner FROM public.indexing_state WHERE chain='celo';")).toBe(ownerB);
  });

  test('zero matches is a successful scan; later failure preserves successful checkpoint', () => {
    acquire();
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up',NULL,'100','100',20,0,0,0);`)).toBe('t');
    const previous = JSON.parse(query("SELECT row_to_json(s) FROM public.indexing_state s WHERE chain='celo';"));
    expect(previous.last_success_at).not.toBeNull();
    expect(previous.inserted_count).toBe(0);
    expect(previous.owner).toBeNull();
    acquire(ownerB);
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerB}','failed','rpc_rate_limited','150','200',2,98,1,3);`)).toBe('t');
    const failed = JSON.parse(query("SELECT row_to_json(s) FROM public.indexing_state s WHERE chain='celo';"));
    expect(failed.status).toBe('failed');
    expect(failed.checkpoint).toBe('100');
    expect(failed.last_success_at).toBe(previous.last_success_at);
    expect(failed.pending_count).toBe(98);
    expect(failed.unresolved_count).toBe(3);
  });

  test('bounded partial success remains catching_up and expires cannot renew itself', () => {
    acquire();
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','catching_up',NULL,'40','100',40,60,2,1);`)).toBe('t');
    expect(query("SELECT status || ':' || pending_count FROM public.indexing_state;")).toBe('catching_up:60');
    acquire(ownerB);
    query("UPDATE public.indexing_state SET lease_until=clock_timestamp()-interval '1 second';");
    expect(query(`SET ROLE service_role; SELECT public.renew_indexing_lease('celo','transfers','${ownerB}',60000);`)).toBe('f');
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerB}','dormant');`)).toBe('f');
  });

  test('partial and dormant runs never advance the last fully successful scan', () => {
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up',NULL,'100','100',20,0,0,0);`);
    const previous = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    for (const status of ['catching_up', 'dormant']) {
      acquire(ownerB);
      const reason = status === 'catching_up' ? 'coverage_incomplete' : 'no_eligible_targets';
      query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerB}','${status}','${reason}','150','200',5,50,0,2);`);
      const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
      expect(state.last_success_at).toBe(previous.last_success_at);
      expect(state.last_finished_at).not.toBe(previous.last_finished_at);
      expect(state.error_code).toBe(reason);
    }
  });

  test('caught_up cannot claim complete coverage with pending or unresolved scope', () => {
    acquire();
    for (const [pending, unresolved] of [[1, 0], [0, 1]]) {
      expect(() => query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up',NULL,'100','100',20,${pending},0,${unresolved});`))
        .toThrow('indexing_coverage_incomplete');
    }
    const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    expect(state.last_success_at).toBeNull();
    expect(state.owner).toBe(ownerA);
  });

  test('a failed attempt cannot erase previously reported unresolved coverage', () => {
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','catching_up','coverage_incomplete','100','200',20,100,0,7);`);
    acquire(ownerB);
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerB}','failed','rpc_unavailable',NULL,NULL,0,0,0,0);`);
    const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    expect(state.unresolved_count).toBe(7);
    expect(state.checkpoint).toBe('100');
    expect(state.last_success_at).toBeNull();
  });

  test('historical gaps stay separate from retriable misses and prevent false caught_up', () => {
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up',NULL,'50','50',10,0,0,0,0);`);
    const success = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;')).last_success_at;
    acquire(ownerB);
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerB}','catching_up','archive_gap','100','200',20,1,0,2,3);`);
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up',NULL,'200','200',20,0,0,0,0);`);
    const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    expect(state.gaps_count).toBe(3);
    expect(state.unresolved_count).toBe(0);
    expect(state.status).toBe('catching_up');
    expect(state.last_success_at).toBe(success);
    expect(state.error_code).toBe('coverage_gap');
  });

  test('new gap evidence increases retained scope; failed or lower-count runs cannot erase it', () => {
    for (const [status, gaps] of [['catching_up', 3], ['catching_up', 5], ['failed', 0], ['catching_up', 1]] as const) {
      acquire();
      query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','${status}',NULL,NULL,NULL,0,0,0,0,${gaps});`);
    }
    expect(query('SELECT gaps_count FROM public.indexing_state;')).toBe('5');
    acquire(ownerB);
    expect(() => query(`SET ROLE service_role; SELECT public.finish_indexing_run('celo','transfers','${ownerB}','catching_up',NULL,NULL,NULL,0,0,0,0,-1);`)).toThrow();
  });

  test('disabled paths cannot be silently reenabled by acquire', () => {
    acquire();
    query('UPDATE public.indexing_state SET enabled=false, owner=NULL, lease_until=NULL;');
    expect(acquire(ownerB)).toBe('');
  });

  test('untrusted roles cannot read state or acquire authority; inputs are bounded', () => {
    for (const role of ['anon', 'authenticated']) {
      expect(() => query(`SET ROLE ${role}; SELECT * FROM public.indexing_state;`)).toThrow('permission denied');
      expect(() => query(`SET ROLE ${role}; SELECT * FROM public.acquire_indexing_lease('celo','transfers','${ownerA}',60000,300000,true);`)).toThrow('permission denied');
      expect(() => query(`SET ROLE ${role}; SELECT public.renew_indexing_lease('celo','transfers','${ownerA}',60000);`)).toThrow('permission denied');
      expect(() => query(`SET ROLE ${role}; SELECT public.finish_indexing_run('celo','transfers','${ownerA}','caught_up');`)).toThrow('permission denied');
    }
    expect(() => query("SET ROLE service_role; INSERT INTO public.indexing_state(chain,path,interval_ms) VALUES ('celo','transfers',300000);")).toThrow('permission denied');
    expect(() => acquire(ownerA, 'bitcoin')).toThrow();
    expect(() => acquire(ownerA, 'celo', 'rpc-url')).toThrow();
    expect(() => query(`SET ROLE service_role; SELECT * FROM public.acquire_indexing_lease('celo','transfers','${ownerA}',0,300000,true);`)).toThrow();
  });

  test('repeatable function deployment preserves active ownership and generated migration matches schema', () => {
    acquire();
    const previous = query('SELECT row_to_json(s) FROM public.indexing_state s;');
    query(readFileSync(resolve('src/db/sql/indexing-state.sql'), 'utf8'));
    expect(query('SELECT row_to_json(s) FROM public.indexing_state s;')).toBe(previous);
    const migration = readFileSync(resolve('drizzle/0018_indexing_state.sql'), 'utf8');
    // Apply the actual additive artifact in a temporary schema; the live table
    // above came from the canonical Drizzle definition, independently generated.
    query('CREATE SCHEMA migration_check; SET search_path=migration_check,public; ' + migration);
    expect(query("SELECT column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='migration_check' AND table_name='indexing_state' ORDER BY ordinal_position;"))
      .toBe(query("SELECT column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public' AND table_name='indexing_state' ORDER BY ordinal_position;"));
    query('DROP SCHEMA migration_check CASCADE;');
  });
});

describe('actual ingestion write fencing', () => {
  const inserts = [
    "INSERT INTO public.wallets(chain,address) VALUES ('celo','agent')",
    "INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('celo','rail','10')",
    "INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature) VALUES ('celo','agent','rail',now(),'tx')",
    "INSERT INTO public.signal_events(chain,agent_wallet,tier,kind) VALUES ('celo','agent',2,'transfer')",
    "INSERT INTO public.erc8004_agents(chain,agent_id,owner) VALUES ('celo',1,'agent')",
    "INSERT INTO public.erc8004_feedback(chain,agent_id,client,feedback_index) VALUES ('celo',1,'reviewer',1)",
  ];
  test('current owner writes every ingestion surface; expired owner is rejected on each', () => {
    acquire();
    inserts.forEach((sql) => fenced(sql));
    query("UPDATE public.indexing_state SET lease_until=clock_timestamp()-interval '1 second';");
    for (const table of ['wallets','indexer_cursors','transactions','signal_events','erc8004_agents','erc8004_feedback']) {
      expect(() => fenced(`DELETE FROM public.${table} WHERE chain='celo'`)).toThrow('indexing_lease_lost');
      expect(() => fenced(`UPDATE public.${table} SET chain='celo' WHERE chain='celo'`)).toThrow('indexing_lease_lost');
    }
    inserts.forEach((sql) => expect(() => fenced(sql)).toThrow('indexing_lease_lost'));
    acquire(ownerB);
    expect(() => fenced("UPDATE public.indexer_cursors SET last_signature='99' WHERE chain='celo'")).toThrow('indexing_lease_lost');
    expect(query("SELECT last_signature FROM public.indexer_cursors WHERE chain='celo';")).toBe('10');
    fenced("UPDATE public.indexer_cursors SET last_signature='20' WHERE chain='celo'", ownerB);
  });

  test('legacy writes retain behavior; partial, forged and cross-chain context fails closed', () => {
    acquire();
    query("SET ROLE service_role; INSERT INTO public.wallets(chain,address) VALUES ('celo','legacy');");
    expect(() => fenced("INSERT INTO public.wallets(chain,address) VALUES ('stellar','wrong-chain')")).toThrow('indexing_chain_mismatch');
    expect(() => query("SET ROLE service_role; SET request.headers='{\"x-indexing-chain\":\"celo\"}'; INSERT INTO public.wallets(chain,address) VALUES ('celo','partial');")).toThrow('indexing_context_invalid');
    query('GRANT INSERT ON public.wallets TO authenticated;');
    expect(() => fenced("INSERT INTO public.wallets(chain,address) VALUES ('celo','spoof')", ownerA, 'authenticated')).toThrow('indexing_context_forbidden');
  });

  test('takeover waits for an already admitted write transaction before fencing old work', async () => {
    acquire();
    const writer = Bun.spawn([bin('psql'), ...pgArgs], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: localEnv });
    writer.stdin.write(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers='{"x-indexing-chain":"celo","x-indexing-path":"transfers","x-indexing-owner":"${ownerA}"}'; INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('celo','rail','10'); SELECT pg_sleep(0.4); COMMIT;`);
    writer.stdin.end();
    // Wait for the writer to hold the state row lock; no timing-based correctness assertion.
    for (let n = 0; n < 100; n++) {
      if (query("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep';") === '1') break;
      await Bun.sleep(10);
    }
    const contender = Bun.spawn([bin('psql'), ...pgArgs], { stdin: Buffer.from(`SET lock_timeout='100ms'; UPDATE public.indexing_state SET lease_until=clock_timestamp()-interval '1 second';`), stdout: 'pipe', stderr: 'pipe', env: localEnv });
    expect(await contender.exited).not.toBe(0);
    expect(await new Response(contender.stderr).text()).toContain('lock timeout');
    expect(await writer.exited).toBe(0);
    query("UPDATE public.indexing_state SET lease_until=clock_timestamp()-interval '1 second';");
    acquire(ownerB);
    expect(() => fenced("UPDATE public.indexer_cursors SET last_signature='99' WHERE chain='celo'")).toThrow('indexing_lease_lost');
  });
});


test('registry explorer replaces the deployed 7c2c7fc view without changing existing column types', () => {
  // Frozen deployed SQL, not reconstructed from the replacement implementation.
  // A private schema in this temporary database exercises actual CREATE OR
  // REPLACE compatibility without dropping the public view or its dependents.
  const deployedView = `
CREATE OR REPLACE VIEW explore_agents AS
  SELECT
    chain, address, display_name, claimed,
    provider_score, consumer_score, trust_tier, confidence_badge,
    autonomy_score, autonomy_label, tx_count, last_seen,
    metric_success_rate, metric_diversity, metric_volume, metric_age, metric_cadence,
    celo_agent_id::bigint   AS celo_agent_id,
    arc_agent_id::bigint    AS arc_agent_id,
    stellar_agent_id::bigint AS stellar_agent_id,
    score,
    image_url,
    rank_score
  FROM wallets
  WHERE chain = 'solana' AND score > 0
  UNION ALL
  SELECT
    chain,
    COALESCE(NULLIF(agent_wallet, '0x0000000000000000000000000000000000000000'), owner) AS address,
    registration->>'name'                AS display_name,
    false                                AS claimed,
    metadata_score::numeric              AS provider_score,
    NULL::numeric                        AS consumer_score,
    CASE
      WHEN metadata_score <= 20 THEN 'Unrated'
      WHEN metadata_score <= 40 THEN 'Poor'
      WHEN metadata_score <= 60 THEN 'Fair'
      WHEN metadata_score <= 75 THEN 'Good'
      WHEN metadata_score <= 90 THEN 'Very Good'
      ELSE 'Excellent'
    END                                  AS trust_tier,
    'declared'                           AS confidence_badge,
    NULL::numeric                        AS autonomy_score,
    NULL::text                           AS autonomy_label,
    0                                    AS tx_count,
    NULL::timestamptz                    AS last_seen,
    NULL::numeric AS metric_success_rate,
    NULL::numeric AS metric_diversity,
    NULL::numeric AS metric_volume,
    NULL::numeric AS metric_age,
    NULL::numeric AS metric_cadence,
    CASE WHEN chain = 'celo'    THEN agent_id END AS celo_agent_id,
    CASE WHEN chain = 'arc'     THEN agent_id END AS arc_agent_id,
    CASE WHEN chain = 'stellar' THEN agent_id END AS stellar_agent_id,
    metadata_score::numeric              AS score,
    registration->>'image'               AS image_url,
    (metadata_score::numeric * 0.7)      AS rank_score
  FROM erc8004_agents
  WHERE chain IN ('celo', 'stellar')
  UNION ALL
  SELECT
    r.chain,
    COALESCE(NULLIF(r.agent_wallet, '0x0000000000000000000000000000000000000000'), r.owner),
    r.registration->>'name', COALESCE(w.claimed, false),
    CASE WHEN w.confidence_badge = 'behavior-inferred' THEN w.provider_score END,
    w.consumer_score, COALESCE(w.trust_tier, 'Unrated'), COALESCE(w.confidence_badge, 'declared'),
    w.autonomy_score, w.autonomy_label, COALESCE(w.tx_count, 0), w.last_seen,
    w.metric_success_rate, w.metric_diversity, w.metric_volume, w.metric_age, w.metric_cadence,
    NULL::bigint, r.agent_id, NULL::bigint,
    COALESCE(w.score, 0), r.registration->>'image', COALESCE(w.rank_score, 0)
  FROM erc8004_agents r
  LEFT JOIN wallets w ON w.chain = r.chain
    AND w.address = COALESCE(NULLIF(r.agent_wallet, '0x0000000000000000000000000000000000000000'), r.owner)
  WHERE r.chain = 'arc-mainnet';
`;
  const currentSql = readFileSync(resolve('src/db/sql/explore-agents-view.sql'), 'utf8');
  query(`BEGIN;
    CREATE SCHEMA deployed_explorer_fixture;
    SET LOCAL search_path=deployed_explorer_fixture,public;
    ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS image_url text;
    ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS rank_score numeric(6,2)
      GENERATED ALWAYS AS (score * CASE WHEN confidence_badge='declared' THEN 0.7 ELSE 1.0 END) STORED;
    ${deployedView}
    CREATE VIEW dependent_explorer AS SELECT autonomy_score,metric_cadence FROM explore_agents;
    ${currentSql}
    SELECT * FROM dependent_explorer LIMIT 1;
    ${currentSql}
    ROLLBACK;`);
});

test('registry explorer preserves measured metrics, unknowns, identities and chain isolation before pagination', () => {
  query(readFileSync(resolve('src/db/sql/explore-agents-view.sql'), 'utf8'));
  seedArchivedRows(`INSERT INTO wallets(chain,address,score,provider_score,confidence_badge,trust_tier,
      autonomy_score,autonomy_label,tx_count,last_seen,metric_cadence,metric_success_rate,metric_diversity,metric_volume,metric_age)
    VALUES ('stellar','shared',12,12,'behavior-inferred','Unrated',82,'agent-like',8,'2026-09-25T00:00:00Z',0.6,0.75,0.4,0.25,1),
      ('celo','shared',99,99,'receipt-backed','Excellent',0,'human-like',2,'2026-09-24T00:00:00Z',0,0,0,0,0),
      ('arc-mainnet','shared',90,90,'behavior-inferred','Very Good',99,'agent-like',999,now(),0.99,1,0.99,0.99,0.99);
    INSERT INTO erc8004_agents(chain,agent_id,owner,agent_wallet,metadata_score,registration)
    VALUES ('stellar',0,'owner','shared',80,'{"name":"First"}'),
      ('stellar',1,'owner','shared',100,'{"name":"Second"}'),
      ('stellar',2,'missing',NULL,100,'{"name":"Unknown"}'),
      ('celo',0,'shared','0x0000000000000000000000000000000000000000',70,'{"name":"Zero"}'),
      ('celo',1,'missing',NULL,100,'{"name":"Missing"}');`);
  const rows = JSON.parse(query(`SELECT json_agg(t) FROM (SELECT * FROM explore_agents
    ORDER BY chain,stellar_agent_id,celo_agent_id) t;`));
  expect(rows).toHaveLength(5);
  expect(rows[0]).toMatchObject({ chain: 'celo', address: 'shared', celo_agent_id: 0, stellar_agent_id: null,
    provider_score: 70, score: 70, rank_score: 49, confidence_badge: 'declared', trust_tier: 'Good',
    autonomy_score: 0, autonomy_label: 'human-like', tx_count: 2, metric_cadence: 0,
    metric_success_rate: 0, metric_diversity: 0, metric_volume: 0, metric_age: 0 });
  for (const row of [rows[1], rows[4]]) {
    expect(row).toMatchObject({ address: 'missing', autonomy_score: null, autonomy_label: null,
      tx_count: 0, last_seen: null, metric_cadence: null, metric_success_rate: null,
      metric_diversity: null, metric_volume: null, metric_age: null });
  }
  expect(rows[2]).toMatchObject({ chain: 'stellar', stellar_agent_id: 0, celo_agent_id: null,
    address: 'shared', display_name: 'First', provider_score: 80, rank_score: 56,
    autonomy_score: 82, autonomy_label: 'agent-like', tx_count: 8, metric_cadence: 0.6,
    metric_success_rate: 0.75, metric_diversity: 0.4, metric_volume: 0.25, metric_age: 1 });
  expect(new Date(rows[2].last_seen).toISOString()).toBe('2026-09-25T00:00:00.000Z');
  expect(rows[3]).toMatchObject({ stellar_agent_id: 1, display_name: 'Second', tx_count: 8, metric_diversity: 0.4 });
  // Same metric population in All and a pinned chain; zero is measured, NULL is unknown.
  expect(query('SELECT count(*) FROM explore_agents WHERE metric_success_rate>=0;')).toBe('3');
  expect(query("SELECT count(*) FROM explore_agents WHERE chain='stellar' AND registry_owner ILIKE '%owner%';")).toBe('2');
  expect(query("SELECT count(*) FROM explore_agents WHERE chain='celo' AND registry_owner ILIKE '%owner%';")).toBe('0');
  expect(query("SELECT count(*) FROM explore_agents WHERE chain='stellar' AND metric_cadence>=0.3 AND metric_diversity>=0.2 AND metric_success_rate>=0.5 AND autonomy_label='agent-like';")).toBe('2');
  expect(query("SELECT stellar_agent_id FROM explore_agents WHERE chain='stellar' AND metric_diversity>=0.2 ORDER BY metric_diversity DESC,stellar_agent_id LIMIT 1 OFFSET 1;")).toBe('1');
  expect(query('SELECT count(*) FROM explore_agents WHERE last_seen IS NULL;')).toBe('2');
  expect(query("SELECT count(*) FROM explore_agents WHERE last_seen>='2026-09-25T00:00:00Z';")).toBe('2');
});

test('mainnet ranking view joins only mainnet scores and preserves every agent identity', () => {
  query(readFileSync(resolve('src/db/sql/explore-agents-view.sql'), 'utf8'));
  seedArchivedRows(`INSERT INTO wallets(chain,address,score,provider_score,consumer_score,confidence_badge,trust_tier,tx_count,last_seen)
    VALUES ('arc','shared',99,99,99,'receipt-backed','Excellent',999,now()),
    ('arc-mainnet','shared',12,12,NULL,'behavior-inferred','Unrated',3,'2026-09-18T00:00:00Z'),
    ('arc-mainnet','sender',0,0,14,'declared','Unrated',4,'2026-09-18T00:00:00Z');
    INSERT INTO erc8004_agents(chain,agent_id,owner,agent_wallet,metadata_score,registration)
    VALUES ('arc-mainnet',0,'owner','shared',100,'{"name":"First"}'),
    ('arc-mainnet',1,'owner','shared',90,'{"name":"Second"}'),
    ('arc-mainnet',2,'sender',NULL,100,'{"name":"Sender"}'),
    ('arc-mainnet',3,'unobserved','0x0000000000000000000000000000000000000000',100,'{"name":"New"}');`);
  const rows=JSON.parse(query(`SELECT json_agg(t) FROM (SELECT address,display_name,arc_agent_id,provider_score,consumer_score,tx_count,rank_score,last_seen FROM explore_agents WHERE chain='arc-mainnet' ORDER BY rank_score DESC,arc_agent_id) t;`));
  expect(rows).toHaveLength(4);
  expect(rows.slice(0,2).map((r: {arc_agent_id:number})=>r.arc_agent_id)).toEqual([0,1]);
  expect(rows[0]).toMatchObject({address:'shared',display_name:'First',provider_score:12,consumer_score:null,tx_count:3,rank_score:12});
  expect(rows[2]).toMatchObject({provider_score:null,consumer_score:14,tx_count:4});
  expect(rows[3]).toMatchObject({address:'unobserved',provider_score:null,consumer_score:null,tx_count:0,last_seen:null});
  expect(query("SELECT count(*) FROM explore_agents WHERE chain='arc-mainnet' AND provider_score>=10;")).toBe('2');
});


describe('Arc testnet retirement', () => {
  test('missing or accidentally reenabled state cannot acquire, renew or finish testnet work', () => {
    expect(acquire(ownerA, 'arc')).toBe('');
    expect(query("SELECT enabled FROM indexing_state WHERE chain='arc';")).toBe('f');
    query(`UPDATE indexing_state SET enabled=true,owner='${ownerA}',lease_until=now()+interval '1 hour' WHERE chain='arc';`);
    expect(acquire(ownerB, 'arc')).toBe('');
    expect(query(`SELECT renew_indexing_lease('arc','transfers','${ownerA}',60000);`)).toBe('f');
    expect(query(`SELECT finish_indexing_run('arc','transfers','${ownerA}','caught_up');`)).toBe('f');
  });

  test('migration disables every testnet path without changing archives, cursors or mainnet enablement', () => {
    seedArchivedRows("INSERT INTO wallets(chain,address) VALUES ('arc','archive'); INSERT INTO indexer_cursors(chain,facilitator,last_signature) VALUES ('arc','rail','123');");
    query(`INSERT INTO indexing_state(chain,path,enabled,interval_ms,checkpoint,owner,lease_until)
      VALUES ('arc','transfers',true,300000,'123','${ownerA}',now()+interval '1 hour'),('arc-mainnet','transfers',true,300000,'456',NULL,NULL);`);
    const migration = readFileSync(resolve('drizzle/0024_retire_arc_testnet.sql'), 'utf8');
    query(migration); query(migration);
    expect(query("SELECT count(*) FROM indexing_state WHERE chain='arc' AND NOT enabled AND owner IS NULL AND lease_until IS NULL;")).toBe('3');
    expect(query("SELECT checkpoint FROM indexing_state WHERE chain='arc' AND path='transfers';")).toBe('123');
    expect(query("SELECT last_signature FROM indexer_cursors WHERE chain='arc';")).toBe('123');
    expect(query("SELECT address FROM wallets WHERE chain='arc';")).toBe('archive');
    expect(query("SELECT enabled || ':' || checkpoint FROM indexing_state WHERE chain='arc-mainnet';")).toBe('true:456');
  });

  test('all historical scoring and indexing tables reject new, changed, deleted and relabeled testnet rows without lease headers', () => {
    const inserts = [
      "INSERT INTO wallets(chain,address) VALUES ('arc','archive')",
      "INSERT INTO indexer_cursors(chain,facilitator,last_signature) VALUES ('arc','rail','123')",
      "INSERT INTO transactions(chain,wallet_address,facilitator,timestamp,tx_signature) VALUES ('arc','archive','rail',now(),'hash')",
      "INSERT INTO signal_events(chain,agent_wallet,tier,kind) VALUES ('arc','archive',2,'transfer')",
      "INSERT INTO erc8004_agents(chain,agent_id,owner) VALUES ('arc',1,'archive')",
      "INSERT INTO erc8004_feedback(chain,agent_id,client,feedback_index) VALUES ('arc',1,'reviewer',1)",
      "INSERT INTO scores(chain,wallet_address,score) VALUES ('arc','archive',42)",
      "INSERT INTO successions(chain,agent_wallet,source_type,interval_seconds,heirs) VALUES ('arc','archive','self_hosted',3600,'[]')",
      "INSERT INTO feedback(chain,agent_wallet,consumer_wallet,rating,tx_signature) VALUES ('arc','archive','consumer','delivered','archive-feedback')",
      "INSERT INTO organization_members(chain,organization_slug,agent_wallet) VALUES ('arc','archive-org','archive')",
      "INSERT INTO agent_manifests(chain,agent_wallet,source_type) VALUES ('arc','archive','self_hosted')",
      `INSERT INTO bonds(id,chain,bonded_agent_wallet,beneficiary,escrow_ref) VALUES ('${ownerA}','arc','archive','beneficiary','escrow')`,
      `INSERT INTO bond_underwriters(chain,bond_id,underwriter_wallet) VALUES ('arc','${ownerA}','archive')`,
      "INSERT INTO celo_x402_payees(chain,address) VALUES ('arc','archive')",
    ];
    query("INSERT INTO organizations(slug,name) VALUES ('archive-org','Archive organization');");
    for (const sql of inserts) expect(() => query('SET ROLE service_role; ' + sql)).toThrow('arc_testnet_retired');
    seedArchivedRows(inserts.join('; '));
    // The same application-role writes on an active chain stay supported.
    query('SET ROLE service_role; ' + inserts.join('; ').replaceAll("'arc'", "'celo'").replaceAll(ownerA, ownerB).replaceAll('archive-feedback', 'active-feedback'));
    for (const table of ['wallets','indexer_cursors','transactions','signal_events','erc8004_agents','erc8004_feedback','scores','successions','feedback','organization_members','agent_manifests','bonds','bond_underwriters','celo_x402_payees']) {
      for (const sql of [`DELETE FROM ${table} WHERE chain='arc'`, `UPDATE ${table} SET chain='arc' WHERE chain='arc'`, `UPDATE ${table} SET chain='arc-mainnet' WHERE chain='arc'`]) {
        expect(() => query('SET ROLE service_role; ' + sql)).toThrow('arc_testnet_retired');
      }
      expect(query(`SELECT count(*) FROM ${table} WHERE chain='arc';`)).toBe('1');
    }
  });
});


test('active listing and transaction aggregates exclude archived testnet without deleting base records', () => {
  query(readFileSync(resolve('src/db/sql/explore-agents-view.sql'), 'utf8'));
  query(readFileSync(resolve('src/db/sql/aggregate-functions.sql'), 'utf8'));
  seedArchivedRows(`INSERT INTO wallets(chain,address) VALUES ('arc','shared'),('arc-mainnet','shared');
    INSERT INTO erc8004_agents(chain,agent_id,owner,agent_wallet,registration) VALUES ('arc',1,'shared','shared','{"name":"Archive"}'),('arc-mainnet',1,'shared','shared','{"name":"Mainnet"}');
    INSERT INTO transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES
    ('arc','shared','shared-rail',now(),'archive',100),('arc-mainnet','shared','shared-rail',now(),'mainnet',2);`);
  expect(query("SELECT string_agg(chain,',') FROM explore_agents WHERE address='shared';")).toBe('arc-mainnet');
  expect(query("SELECT total_count || ':' || total_volume::numeric FROM get_transaction_stats();")).toBe('1:2.000000000000000000');
  expect(query("SELECT tx_count || ':' || unique_agents || ':' || total_volume::numeric FROM get_facilitator_stats() WHERE facilitator='shared-rail';")).toBe('1:1:2.000000000000000000');
  expect(query("SELECT count(*) FROM erc8004_agents WHERE chain='arc';")).toBe('1');
  expect(query("SELECT amount::numeric FROM transactions WHERE chain='arc';")).toBe('100.000000000000000000');
});
