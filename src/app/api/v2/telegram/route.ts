import { handleTelegram } from '@/lib/telegram-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleTelegram(request);
}
