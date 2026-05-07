/**
 * Payload generators for the specimen endpoints. Kept separate so the
 * gated-handler stays generic and Bun + Next.js call sites share output.
 */

const QUOTES = [
  '"Reputation is what other people know about you. Honor is what you know about yourself." — Lois McMaster Bujold',
  '"Code is read more often than it is written." — Guido van Rossum',
  '"In the long run, every program becomes rococo, and then rubble." — Alan Perlis',
  '"Trust takes years to build, seconds to break, and forever to repair."',
  '"Receipts > vibes."',
];

export function echoPayload(): { message: string; servedAt: string } {
  return { message: 'Hello from the AgentKarma specimen', servedAt: new Date().toISOString() };
}

export function quotePayload(): { quote: string; servedAt: string } {
  return { quote: QUOTES[Math.floor(Math.random() * QUOTES.length)], servedAt: new Date().toISOString() };
}
