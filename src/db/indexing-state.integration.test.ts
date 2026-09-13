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
function acquire(owner = ownerA, chain = 'arc', path = 'transfers') {
  return query(`SET ROLE service_role; SELECT row_to_json(s) FROM public.acquire_indexing_lease('${chain}', '${path}', '${owner}', 60000, 300000, true) s;`);
}
function fenced(sql: string, owner = ownerA, role = 'service_role') {
  return query(`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL request.headers = '{"x-indexing-chain":"arc","x-indexing-path":"transfers","x-indexing-owner":"${owner}"}'; ${sql}; COMMIT;`);
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
  query('TRUNCATE public.indexing_state, public.indexer_cursors, public.erc8004_agents, public.wallets CASCADE;');
});

describe('persistent lease and success state', () => {
  test('mainnet receipt keyset pages preserve tied PostgreSQL timestamps and isolate chains', () => {
    query("INSERT INTO public.wallets(chain,address) VALUES ('arc-mainnet','page-wallet'),('arc','page-wallet');");
    query(`INSERT INTO public.signal_events(id,chain,agent_wallet,tier,kind,observed_at)
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
  test('missing Arc mainnet state stays disabled even when acquisition requests enablement', () => {
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

  test('Arc mainnet leases cannot collide with testnet ownership', () => {
    query("INSERT INTO public.indexing_state(chain,path,enabled,interval_ms) VALUES ('arc-mainnet','transfers',true,300000);");
    expect(JSON.parse(acquire(ownerA, 'arc')).owner).toBe(ownerA);
    expect(JSON.parse(acquire(ownerB, 'arc-mainnet')).owner).toBe(ownerB);
    expect(query('SELECT count(*) FROM public.indexing_state;')).toBe('2');
    const mainnetContext = `BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers='{"x-indexing-chain":"arc-mainnet","x-indexing-path":"transfers","x-indexing-owner":"${ownerB}"}';`;
    query(mainnetContext + "INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('arc-mainnet','rail','mainnet-tip'); COMMIT;");
    expect(() => query(mainnetContext + "INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('arc','rail','wrong-network'); COMMIT;")).toThrow('indexing_chain_mismatch');
    expect(query("SELECT chain || ':' || last_signature FROM public.indexer_cursors;")).toBe('arc-mainnet:mainnet-tip');
  });

  test('identical EVM addresses and raw transaction hashes persist independently on both networks', () => {
    const address = '0x1111111111111111111111111111111111111111';
    const hash = '0x' + 'ab'.repeat(32);
    query(`INSERT INTO public.wallets(chain,address) VALUES ('arc','${address}'),('arc-mainnet','${address}');`);
    for (const chain of ['arc', 'arc-mainnet']) {
      query(`INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('${chain}','${address}','rail',now(),'${hash}',1) ON CONFLICT(chain,tx_signature) DO NOTHING;`);
      query(`INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('${chain}','${address}','rail',now(),'${hash}',99) ON CONFLICT(chain,tx_signature) DO NOTHING;`);
    }
    expect(query(`SELECT chain || ':' || amount::numeric::text FROM public.transactions WHERE tx_signature='${hash}' ORDER BY chain;`)).toBe('arc:1.000000000000000000\narc-mainnet:1.000000000000000000');
    expect(query(`SELECT count(DISTINCT id) FROM public.transactions WHERE tx_signature='${hash}';`)).toBe('2');
  });

  test('eighteen-decimal mainnet receipts and existing six-decimal amounts are stored exactly', () => {
    query("INSERT INTO public.wallets(chain,address) VALUES ('arc','same-address'),('arc-mainnet','same-address');");
    query("INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature,amount) VALUES ('arc','same-address','rail',now(),'old-six',1.234567),('arc-mainnet','same-address','rail',now(),'native-wei',0.000000000000000001);");
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
    query("UPDATE public.indexing_state SET lease_until = clock_timestamp() - interval '1 second' WHERE chain = 'arc';");
    expect(JSON.parse(acquire(ownerB)).generation).toBe(2);
    expect(query(`SET ROLE service_role; SELECT public.renew_indexing_lease('arc','transfers','${ownerA}',60000);`)).toBe('f');
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up');`)).toBe('f');
    expect(query("SELECT owner FROM public.indexing_state WHERE chain='arc';")).toBe(ownerB);
  });

  test('zero matches is a successful scan; later failure preserves successful checkpoint', () => {
    acquire();
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up',NULL,'100','100',20,0,0,0);`)).toBe('t');
    const previous = JSON.parse(query("SELECT row_to_json(s) FROM public.indexing_state s WHERE chain='arc';"));
    expect(previous.last_success_at).not.toBeNull();
    expect(previous.inserted_count).toBe(0);
    expect(previous.owner).toBeNull();
    acquire(ownerB);
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerB}','failed','rpc_rate_limited','150','200',2,98,1,3);`)).toBe('t');
    const failed = JSON.parse(query("SELECT row_to_json(s) FROM public.indexing_state s WHERE chain='arc';"));
    expect(failed.status).toBe('failed');
    expect(failed.checkpoint).toBe('100');
    expect(failed.last_success_at).toBe(previous.last_success_at);
    expect(failed.pending_count).toBe(98);
    expect(failed.unresolved_count).toBe(3);
  });

  test('bounded partial success remains catching_up and expires cannot renew itself', () => {
    acquire();
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','catching_up',NULL,'40','100',40,60,2,1);`)).toBe('t');
    expect(query("SELECT status || ':' || pending_count FROM public.indexing_state;")).toBe('catching_up:60');
    acquire(ownerB);
    query("UPDATE public.indexing_state SET lease_until=clock_timestamp()-interval '1 second';");
    expect(query(`SET ROLE service_role; SELECT public.renew_indexing_lease('arc','transfers','${ownerB}',60000);`)).toBe('f');
    expect(query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerB}','dormant');`)).toBe('f');
  });

  test('partial and dormant runs never advance the last fully successful scan', () => {
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up',NULL,'100','100',20,0,0,0);`);
    const previous = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    for (const status of ['catching_up', 'dormant']) {
      acquire(ownerB);
      const reason = status === 'catching_up' ? 'coverage_incomplete' : 'no_eligible_targets';
      query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerB}','${status}','${reason}','150','200',5,50,0,2);`);
      const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
      expect(state.last_success_at).toBe(previous.last_success_at);
      expect(state.last_finished_at).not.toBe(previous.last_finished_at);
      expect(state.error_code).toBe(reason);
    }
  });

  test('caught_up cannot claim complete coverage with pending or unresolved scope', () => {
    acquire();
    for (const [pending, unresolved] of [[1, 0], [0, 1]]) {
      expect(() => query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up',NULL,'100','100',20,${pending},0,${unresolved});`))
        .toThrow('indexing_coverage_incomplete');
    }
    const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    expect(state.last_success_at).toBeNull();
    expect(state.owner).toBe(ownerA);
  });

  test('a failed attempt cannot erase previously reported unresolved coverage', () => {
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','catching_up','coverage_incomplete','100','200',20,100,0,7);`);
    acquire(ownerB);
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerB}','failed','rpc_unavailable',NULL,NULL,0,0,0,0);`);
    const state = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;'));
    expect(state.unresolved_count).toBe(7);
    expect(state.checkpoint).toBe('100');
    expect(state.last_success_at).toBeNull();
  });

  test('historical gaps stay separate from retriable misses and prevent false caught_up', () => {
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up',NULL,'50','50',10,0,0,0,0);`);
    const success = JSON.parse(query('SELECT row_to_json(s) FROM public.indexing_state s;')).last_success_at;
    acquire(ownerB);
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerB}','catching_up','archive_gap','100','200',20,1,0,2,3);`);
    acquire();
    query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up',NULL,'200','200',20,0,0,0,0);`);
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
      query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','${status}',NULL,NULL,NULL,0,0,0,0,${gaps});`);
    }
    expect(query('SELECT gaps_count FROM public.indexing_state;')).toBe('5');
    acquire(ownerB);
    expect(() => query(`SET ROLE service_role; SELECT public.finish_indexing_run('arc','transfers','${ownerB}','catching_up',NULL,NULL,NULL,0,0,0,0,-1);`)).toThrow();
  });

  test('disabled paths cannot be silently reenabled by acquire', () => {
    acquire();
    query('UPDATE public.indexing_state SET enabled=false, owner=NULL, lease_until=NULL;');
    expect(acquire(ownerB)).toBe('');
  });

  test('untrusted roles cannot read state or acquire authority; inputs are bounded', () => {
    for (const role of ['anon', 'authenticated']) {
      expect(() => query(`SET ROLE ${role}; SELECT * FROM public.indexing_state;`)).toThrow('permission denied');
      expect(() => query(`SET ROLE ${role}; SELECT * FROM public.acquire_indexing_lease('arc','transfers','${ownerA}',60000,300000,true);`)).toThrow('permission denied');
      expect(() => query(`SET ROLE ${role}; SELECT public.renew_indexing_lease('arc','transfers','${ownerA}',60000);`)).toThrow('permission denied');
      expect(() => query(`SET ROLE ${role}; SELECT public.finish_indexing_run('arc','transfers','${ownerA}','caught_up');`)).toThrow('permission denied');
    }
    expect(() => query("SET ROLE service_role; INSERT INTO public.indexing_state(chain,path,interval_ms) VALUES ('arc','transfers',300000);")).toThrow('permission denied');
    expect(() => acquire(ownerA, 'bitcoin')).toThrow();
    expect(() => acquire(ownerA, 'arc', 'rpc-url')).toThrow();
    expect(() => query(`SET ROLE service_role; SELECT * FROM public.acquire_indexing_lease('arc','transfers','${ownerA}',0,300000,true);`)).toThrow();
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
    "INSERT INTO public.wallets(chain,address) VALUES ('arc','agent')",
    "INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('arc','rail','10')",
    "INSERT INTO public.transactions(chain,wallet_address,facilitator,timestamp,tx_signature) VALUES ('arc','agent','rail',now(),'tx')",
    "INSERT INTO public.signal_events(chain,agent_wallet,tier,kind) VALUES ('arc','agent',2,'transfer')",
    "INSERT INTO public.erc8004_agents(chain,agent_id,owner) VALUES ('arc',1,'agent')",
    "INSERT INTO public.erc8004_feedback(chain,agent_id,client,feedback_index) VALUES ('arc',1,'reviewer',1)",
  ];
  test('current owner writes every ingestion surface; expired owner is rejected on each', () => {
    acquire();
    inserts.forEach((sql) => fenced(sql));
    query("UPDATE public.indexing_state SET lease_until=clock_timestamp()-interval '1 second';");
    for (const table of ['wallets','indexer_cursors','transactions','signal_events','erc8004_agents','erc8004_feedback']) {
      expect(() => fenced(`DELETE FROM public.${table} WHERE chain='arc'`)).toThrow('indexing_lease_lost');
      expect(() => fenced(`UPDATE public.${table} SET chain='arc' WHERE chain='arc'`)).toThrow('indexing_lease_lost');
    }
    inserts.forEach((sql) => expect(() => fenced(sql)).toThrow('indexing_lease_lost'));
    acquire(ownerB);
    expect(() => fenced("UPDATE public.indexer_cursors SET last_signature='99' WHERE chain='arc'")).toThrow('indexing_lease_lost');
    expect(query("SELECT last_signature FROM public.indexer_cursors WHERE chain='arc';")).toBe('10');
    fenced("UPDATE public.indexer_cursors SET last_signature='20' WHERE chain='arc'", ownerB);
  });

  test('legacy writes retain behavior; partial, forged and cross-chain context fails closed', () => {
    acquire();
    query("SET ROLE service_role; INSERT INTO public.wallets(chain,address) VALUES ('arc','legacy');");
    expect(() => fenced("INSERT INTO public.wallets(chain,address) VALUES ('stellar','wrong-chain')")).toThrow('indexing_chain_mismatch');
    expect(() => query("SET ROLE service_role; SET request.headers='{\"x-indexing-chain\":\"arc\"}'; INSERT INTO public.wallets(chain,address) VALUES ('arc','partial');")).toThrow('indexing_context_invalid');
    query('GRANT INSERT ON public.wallets TO authenticated;');
    expect(() => fenced("INSERT INTO public.wallets(chain,address) VALUES ('arc','spoof')", ownerA, 'authenticated')).toThrow('indexing_context_forbidden');
  });

  test('takeover waits for an already admitted write transaction before fencing old work', async () => {
    acquire();
    const writer = Bun.spawn([bin('psql'), ...pgArgs], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: localEnv });
    writer.stdin.write(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers='{"x-indexing-chain":"arc","x-indexing-path":"transfers","x-indexing-owner":"${ownerA}"}'; INSERT INTO public.indexer_cursors(chain,facilitator,last_signature) VALUES ('arc','rail','10'); SELECT pg_sleep(0.4); COMMIT;`);
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
    expect(() => fenced("UPDATE public.indexer_cursors SET last_signature='99' WHERE chain='arc'")).toThrow('indexing_lease_lost');
  });
});
