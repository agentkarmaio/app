import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Titled placeholder for a card that is still streaming in behind `Suspense`.
 *
 * The title renders for real so the reader knows what is arriving; only the
 * rows pulse. Shared by every agent-profile surface (Solana body, Celo/Arc/
 * Stellar on-chain sections) so a streaming card looks the same on every chain.
 */
export function CardSkeleton({ title, rows = 5 }: { title: string; rows?: number }) {
  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-4">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-3 rounded bg-[rgb(255_255_255/0.04)] animate-pulse"
            style={{ width: `${100 - i * 8}%` }}
          />
        ))}
      </CardContent>
    </Card>
  );
}
