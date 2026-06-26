// Self-hosted, same-origin app: it only ever talks to its own /api/* routes and
// serves self-hosted fonts/JS/CSS. The CSP keeps 'unsafe-inline' (Next injects
// inline bootstrap scripts + React inline styles) but locks everything else to
// 'self', and frame-ancestors 'none' blocks clickjacking.
// Next's dev server uses eval() for HMR/source maps, so 'unsafe-eval' is needed
// in development only — production builds don't eval, keeping the prod CSP strict.
const dev = process.env.NODE_ENV !== "production";
const scriptSrc = dev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";

const csp = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src ${scriptSrc}`,
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

/** @type {import('next').NextConfig} */
export default {
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
