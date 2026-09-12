interface LegacyGapState {
  enabled: boolean;
  owner: string | null;
  lease_until: string | null;
}
interface StateRead { data: LegacyGapState | null; error: { code?: string } | null }

/** Legacy archive walks can last 5.5 hours and share the live payment cursors. */
export async function assertLegacyGapWriteAllowed(
  readState: () => Promise<StateRead> = async () => {
    const { supabase } = await import('@/db/client');
    return supabase.from('indexing_state').select('enabled,owner,lease_until')
      .eq('chain', 'solana').eq('path', 'payments').maybeSingle();
  },
): Promise<void> {
  const { data, error } = await readState();
  if (error) {
    // Before the additive indexing-state migration, preserve the old command.
    if (error.code === '42P01' || error.code === 'PGRST205') return;
    throw new Error('Legacy gap recovery refused: managed indexing state could not be verified');
  }
  if (data?.enabled) {
    throw new Error('Legacy gap recovery refused: managed Solana payments must be intentionally paused before bulk recovery');
  }
  if (data?.owner && (!data.lease_until || !Number.isFinite(Date.parse(data.lease_until)) || Date.parse(data.lease_until) > Date.now())) {
    throw new Error('Legacy gap recovery refused: the active lease must finish before bulk recovery');
  }
}
