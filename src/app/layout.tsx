import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { Navbar } from "@/components/layout/navbar";
import { SolanaWalletProvider } from "@/components/wallet/wallet-provider";

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: "Karma — Reputation Layer for Autonomous On-Chain Agents",
  description: "Passive, manipulation-resistant trust scores for any autonomous agent with a Solana footprint. x402-first, not x402-only.",
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#08090a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("dark font-sans", inter.variable, mono.variable)}>
      <body className="min-h-screen overflow-x-hidden bg-background antialiased">
        <SolanaWalletProvider>
          <Navbar />
          <main className="mx-auto max-w-5xl px-4 py-8">
            {children}
          </main>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
