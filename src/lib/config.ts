// EDGE-RUNTIME MODULE. loadConfig() runs inside middleware (via auth.ts) on the
// Edge runtime — keep this file free of Node-only APIs (Buffer, node:*, fs).
export interface Config {
  seedQueries: string[];
  appTitle: string;
  appSubtitle: string;
  authMode: "none" | "password" | "gateway";
  uiPassword: string;
  gateway: GatewayConfig;
  // "none" auth is fail-open. Require explicit opt-in so a deploy that forgets
  // to set AUTH_MODE doesn't silently serve a private brain to the internet.
  allowInsecure: boolean;
}

// Trusted-gateway auth: an upstream proxy (Cloudflare Access, oauth2-proxy,
// Authelia, an ingress controller) authenticates the user and forwards who they
// are in a header.
//
// The whole mode turns on one question: how do we know the request came from the
// gateway? A header is typed by whoever is talking to us, so trusting
// `X-Forwarded-User` on its own is not authentication — it is a login form with
// no password. So the identity header is read ONLY after one of two proofs:
//
//   jwks  — verify a JWT the gateway signed (signature, issuer, audience, exp).
//           Strongest, and what Cloudflare Access already sends.
//   secret — a shared secret the gateway adds and no client can guess, compared
//           in constant time. Works with any proxy that can set a header.
//
// Neither configured ⇒ the mode refuses every request. There is deliberately no
// "just trust the header" setting: a deployment that wants one can put the proxy
// on localhost and use a secret, which costs one env var and is not a footgun.
export interface GatewayConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  jwtHeader: string;
  sharedSecret: string;
  secretHeader: string;
  userHeader: string;
}

const DEFAULT_SEEDS = [
  "overview getting started",
  "architecture design decisions",
  "people team roles",
  "projects products",
];

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const seeds = (env.SEED_QUERIES ?? "")
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = env.AUTH_MODE;
  return {
    seedQueries: seeds.length ? seeds : DEFAULT_SEEDS,
    appTitle: env.APP_TITLE ?? "Lore",
    appSubtitle: env.APP_SUBTITLE ?? "A searchable knowledge graph of your memory.",
    authMode: mode === "password" || mode === "gateway" ? mode : "none",
    uiPassword: env.UI_PASSWORD ?? "",
    gateway: {
      jwksUrl: env.AUTH_GATEWAY_JWKS_URL ?? "",
      issuer: env.AUTH_GATEWAY_ISSUER ?? "",
      audience: env.AUTH_GATEWAY_AUDIENCE ?? "",
      // Cloudflare Access's header, because it is the one most people arrive
      // with; any gateway that signs a JWT can point this elsewhere.
      jwtHeader: env.AUTH_GATEWAY_JWT_HEADER ?? "Cf-Access-Jwt-Assertion",
      sharedSecret: env.AUTH_GATEWAY_SHARED_SECRET ?? "",
      secretHeader: env.AUTH_GATEWAY_SECRET_HEADER ?? "X-Auth-Gateway-Secret",
      userHeader: env.AUTH_GATEWAY_USER_HEADER ?? "X-Forwarded-User",
    },
    allowInsecure: env.ALLOW_INSECURE === "1" || env.ALLOW_INSECURE === "true",
  };
}
