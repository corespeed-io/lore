import "./globals.css";
import { loadConfig } from "@/lib/config";

export function generateMetadata() {
  const { appTitle } = loadConfig();
  return { title: appTitle };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
