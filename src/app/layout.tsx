import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { loadConfig } from "@/lib/config";

const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-geist-mono",
  display: "swap",
});

export function generateMetadata() {
  const { appTitle } = loadConfig();
  return {
    title: appTitle === "Lore" ? "Lore" : `Lore — ${appTitle}`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
