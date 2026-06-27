import "./globals.css";
import { loadConfig } from "@/lib/config";
import { Geist, Geist_Mono } from "next/font/google";

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

// Render at request time, not build time. appTitle/appSubtitle come from
// runtime env (APP_TITLE), but a Docker build has no service vars, so static
// prerendering would bake the "gbrain" default into the HTML and ignore the
// runtime value. force-dynamic keeps this server-rendered (SSR) but per-request,
// so the configured title actually shows. Applies to the whole route subtree.
export const dynamic = "force-dynamic";

export function generateMetadata() {
  const { appTitle } = loadConfig();
  return { title: `Lore — ${appTitle}`, icons: { icon: "/favicon.svg" } };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
