import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getFacilitatorName } from '@/config/facilitators';

interface TxRow {
  id: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
}

function TxSignature({ signature }: { signature: string }) {
  const display = `${signature.slice(0, 8)}...`;
  // Real Solana signatures are 88 chars base58 and don't start with known demo prefixes
  const isOnChain = signature.length === 88 && !signature.startsWith('demo_');

  if (!isOnChain) {
    return <span className="font-mono text-xs text-[#62666d]">{display}</span>;
  }

  return (
    <a
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-[#62666d] hover:text-[#8a8f98] transition-colors"
    >
      {display}
    </a>
  );
}

export function TransactionList({ transactions }: { transactions: TxRow[] }) {
  if (transactions.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No transactions recorded yet.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Facilitator</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-center">Status</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Date</TableHead>
          <TableHead className="text-right hidden md:table-cell">Signature</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((tx) => (
          <TableRow key={tx.id}>
            <TableCell className="font-medium capitalize">
              {getFacilitatorName(tx.facilitator) ?? tx.facilitator.slice(0, 8) + '...'}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              ${Number(tx.amount).toFixed(2)}
            </TableCell>
            <TableCell className="text-center">
              <Badge
                variant="outline"
                className={
                  tx.success
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400'
                    : 'border-red-200 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400'
                }
              >
                {tx.success ? 'OK' : 'Failed'}
              </Badge>
            </TableCell>
            <TableCell className="text-right text-sm text-muted-foreground hidden sm:table-cell">
              {new Date(tx.timestamp).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </TableCell>
            <TableCell className="text-right hidden md:table-cell">
              <TxSignature signature={tx.tx_signature} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
