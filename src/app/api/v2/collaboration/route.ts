import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rate-limit';

const application = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254),
  telegram: z.string().trim().regex(/^[A-Za-z0-9_]{5,32}$/),
  project: z.string().trim().min(2).max(200),
  message: z.string().trim().min(20).max(2000),
  website: z.string().max(0).optional(), // Honeypot, not a project URL field.
});

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = origin === 'https://agentkarma.io' || origin === 'https://www.agentkarma.io'
    || (process.env.NODE_ENV !== 'production' && origin === new URL(request.url).origin);
  if (!allowed) {
    return Response.json({ error: 'Please submit from the AgentKarma website.' }, { status: 403 });
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'Invalid request.' }, { status: 415 });
  }
  const gate = await enforceRateLimit('collaboration', request);
  if (!gate.ok) return gate.response;

  let data;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'Invalid application.' }, { status: 400 });
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 12000) {
          await reader.cancel();
          return Response.json({ error: 'Application is too long.' }, { status: 413 });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    data = application.safeParse(JSON.parse(text));
  } catch {
    return Response.json({ error: 'Invalid application.' }, { status: 400 });
  }
  if (!data.success) {
    return Response.json({ error: 'Check your details, Telegram username, and email. Include at least 20 characters about your idea.' }, { status: 400 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return Response.json({ error: 'Applications are temporarily unavailable. Please try again later.' }, { status: 503 });
  }
  const { name, email, telegram, project, message } = data.data;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `AgentKarma · Collaboration application\n\nName: ${name}\nEmail: ${email}\nTelegram: @${telegram}\nProject: ${project}\n\n${message}`,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error('Delivery failed');
    return Response.json({ ok: true });
  } catch {
    // Never log the fetch error: it can contain the bot token in its URL.
    return Response.json({ error: 'We could not confirm delivery. Please try again shortly.' }, { status: 502 });
  }
}
