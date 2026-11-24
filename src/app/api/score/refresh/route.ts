import { NextRequest, NextResponse } from 'next/server';
import { markAllWalletsDirty } from '@/db/client';
import { rescoreWallet } from '@/scripts/rescore-dirty';
import { requireBearerSecret } from '@/lib/api-auth';
import { enforceRateLimit } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const auth = requireBearerSecret(request, 'SCORE_REFRESH_TOKEN');
  if (!auth.ok) return auth.response;

  const gate = await enforceRateLimit('score-refresh', request);
  if (!gate.ok) return gate.response;

  const body = await request.json().catch(() => ({}));
  if ((body as { chain?: string }).chain === 'arc') {
    return NextResponse.json({ error: 'Arc testnet is retired. Historical profiles remain read-only.' }, { status: 410 });
  }
  const wallet = (body as { wallet?: string }).wallet;

  if (wallet) {
    // Same path as the rescore queue: shared score assembly, then persist.
    let score;
    try {
      score = await rescoreWallet({ chain: 'solana', address: wallet });
    } catch (err) {
      // An unreadable input (8004 endpoint, feedback, …) — never persist a
      // score built without it; the caller can retry.
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 503 },
      );
    }
    if (!score) {
      return NextResponse.json({ error: 'No transactions found for wallet' }, { status: 404 });
    }
    return NextResponse.json({ refreshed: 1, wallet: score });
  }

  // No wallet → full rescore. This ENQUEUES rather than scoring inline: the old
  // inline version read every transaction into memory, then looped feedback +
  // upsert + snapshot over ~105k wallets one at a time (~315k sequential round
  // trips), which cannot complete inside a request. Marking every wallet dirty
  // is one statement; the scoring worker drains the queue at its own bounded
  // rate with a bounded per-wallet window.
  const queued = await markAllWalletsDirty();

  return NextResponse.json({
    queued,
    message:
      `Queued ${queued} wallets for rescoring. Scoring runs in the background ` +
      '(scoring worker / POST /api/cron/rescore); this endpoint no longer scores inline.',
  });
}
