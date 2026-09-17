# Hono as the outer server for Next.js: community source audit

Researched: 2026-09-17

Scope: one application/process in which Hono handles API and operational routes,
then delegates page rendering to Next.js. This includes source research and an
isolated Bun runtime probe, not a completed Lore deployment migration.

## Selected architecture

After this investigation, the user chose **Bun → Next.js → Hono**, using the
official `hono/vercel` adapter in Next's API catch-all. Next keeps the page routes,
thin health-route adapters, native development reload, and standalone packaging.
The later 2026-09-17 runtime decision also moved self-host maintenance and
database tooling to Bun. Cloudflare continues to dispatch APIs to Hono and pages
to OpenNext on workerd. The alternative runtime observations below remain
historical research evidence.

The custom outer-server design and isolated runtime probe below are retained as
research into an alternative. They do not describe Lore's selected server entry
or validate its deployment. Current runtime instructions live in
[the architecture guide](../architecture.md#api-runtimes) and
[the technical reference](../reference.md#application-process-layout).

Source: [Hono's official Next.js integration](https://hono.dev/docs/getting-started/nextjs).

## Finding

The building blocks exist in official packages, and there is a concrete community
application using them. No maintained, general-purpose Next/Hono integration
package that removes the deployment differences was established by this search.
The closest named package, `hono-next`, solves a different problem: static Next
export plus a Cloudflare API.

For Node self-hosting, the smallest established composition is Next's custom
server API plus `@hono/node-server`. The Hono adapter exposes the raw Node request
and response through `HttpBindings`, and explicitly documents returning
`RESPONSE_ALREADY_SENT` when another handler owns the response. That supplies the
handoff required by Next's `getRequestHandler()` without an HTTP proxy or a second
listening server. This is an inference from the two documented APIs, supported by
the application example below.

Sources: [Hono Node adapter, direct responses](https://github.com/honojs/node-server/tree/64dc09e0c37eab30b51d33d61a3a2bae3fdee263#direct-response-from-nodejs-api),
[Next custom server](https://nextjs.org/docs/app/guides/custom-server).

## Candidates and exclusions

| Candidate | What the source actually does | Relevance |
| --- | --- | --- |
| Official `@hono/node-server` plus Next custom server | Hono can access Node `incoming`/`outgoing`; Next renders into those objects; the Hono sentinel suppresses an additional response. | Suitable building blocks for a small self-host entry. Not a turnkey Next adapter. |
| [`huy97/myops`](https://github.com/huy97/myops/blob/6b1ee5ddc6098dfefa2b560554b789b5e9df691e/server.ts) | Mounts Hono API/WebSocket routes, then an `app.all("*", ...)` fallback invokes Next on the raw request/response. | Concrete same-process example using Next 16.2.12. An application, not an integration library. |
| [`tsuyuni/hono-next`](https://github.com/tsuyuni/hono-next/tree/e051ba29f0c12cde4177873f0ca93b8555cfdd1e) | Requires `output: "export"`; deployment rejects other output modes. Development launches Next and Wrangler behind an HTTP proxy. | Does not retain runtime Next rendering or the requested single-process development model. |
| [`vercel/hono-nextjs`](https://github.com/vercel/hono-nextjs/tree/9badccd9c207e3e14d27e6a97d43ff70e6e42a88) | Its README directs API edits to `app/api/[...route]/route.tsx`. | Official-owner example of Hono inside Next, not Hono as the outer server. |
| [`spa5k/GreenDome`](https://github.com/spa5k/GreenDome/blob/0d0fac65024b9dd1c9ebbd657b1c881413ce50bd/electron/src/server/index.ts) | Starts a Hono API on an available localhost port in 50000–51000. | Mentioned in a Next custom-server discussion, but the actual source is a separate API listener, not a Next rendering fallback. |

The `next-hono` npm registry endpoint returned HTTP 404 during this audit; do not
recommend that name as an existing package.

## Version, development, and packaging boundaries

`myops` pins Next 16.2.12 and declares Hono `^4.12.32` and the Node adapter
`^2.0.12`. Its latest observed repository commit was 2026-08-13. It forwards
nonapplication WebSocket upgrades to `nextApp.getUpgradeHandler()` so Next HMR
can work; server changes restart through `tsx watch`. Shutdown calls
`nextApp.close()` to release the development build lock. Its Next configuration
does not enable standalone output, and its production command runs the custom
server with `tsx`. These are source observations, not an independent HMR or
production test. The repository does not establish a broader Next compatibility
matrix or an integration test guarantee.

Sources: [server](https://github.com/huy97/myops/blob/6b1ee5ddc6098dfefa2b560554b789b5e9df691e/server.ts),
[package scripts and versions](https://github.com/huy97/myops/blob/6b1ee5ddc6098dfefa2b560554b789b5e9df691e/package.json),
[Next configuration](https://github.com/huy97/myops/blob/6b1ee5ddc6098dfefa2b560554b789b5e9df691e/next.config.ts).

`hono-next`'s latest observed npm version was 0.1.11, published 2025-08-15,
with peer dependencies `next: ^14 || ^15` and `hono: ^4`. The repository's latest
commit was also on 2025-08-15. Its development proxy code does not show a WebSocket
upgrade listener, so HMR through that proxy should not be assumed to work.

Sources: [npm metadata](https://registry.npmjs.org/hono-next),
[package manifest](https://github.com/tsuyuni/hono-next/blob/e051ba29f0c12cde4177873f0ca93b8555cfdd1e/package.json),
[development command](https://github.com/tsuyuni/hono-next/blob/e051ba29f0c12cde4177873f0ca93b8555cfdd1e/src/bin/commands/dev.ts),
[deployment command](https://github.com/tsuyuni/hono-next/blob/e051ba29f0c12cde4177873f0ca93b8555cfdd1e/src/bin/commands/deploy.ts).

Next's official documentation states that standalone output does not trace custom
server files and emits its own minimal server. Switching Lore's self-host entry to
this composition therefore requires an explicit packaging change, not merely
deleting its Route Handler files. Custom server code also sits outside Next's
compiler. Header ownership must be resolved before Next begins writing the raw
response; ordinary Hono response middleware should not be presumed to modify a
response already sent by Next.

Source: [Next custom-server constraints](https://nextjs.org/docs/app/guides/custom-server).

Cloudflare has a separate documented mechanism: an OpenNext custom Worker can
handle selected requests and pass the remainder to the generated Worker's fetch
handler. That is the appropriate composition seam for workerd; the raw Node
request/response adapter above is not a portable replacement. Lore already uses
this kind of outer dispatch. One universal self-host/Workers adapter was not
established by the reviewed projects.

Source: [OpenNext custom Worker](https://opennext.js.org/cloudflare/howtos/custom-worker).

## Middleware / Proxy alternative

An author-published implementation also runs Hono inside Next Middleware, returning
`NextResponse.next()` for requests that should reach Next pages. This avoids a
custom listening server, but remains inside Next's interception layer. Next's
current Proxy documentation says that layer is not intended for slow data fetching;
it should not automatically become Lore's database and retrieval backend.

Sources: [CoeFont's Hono middleware implementation](https://zenn.dev/coefont/articles/using-hono-in-next-middleware),
[Next Proxy use cases](https://nextjs.org/docs/app/getting-started/proxy).

Lore currently installs OpenNext Cloudflare 1.20.2, whose Next-server patch disables
Node middleware. The official 1.20.3 release adds experimental Node middleware /
`proxy.ts` support with `nodejs_compat`. Blanket claims that OpenNext cannot support
Proxy are therefore outdated, but this newer experimental integration has not been
validated in Lore and is not evidence of a production-ready replacement backend.

Source: [OpenNext Cloudflare 1.20.3 release](https://github.com/opennextjs/opennextjs-cloudflare/releases/tag/%40opennextjs%2Fcloudflare%401.20.3).

## Bun runtime follow-up

Bun is a runtime choice; `node:http` is an API contract. Running a custom entry
with `bun server.ts` can use `@hono/node-server` without starting a Node process.
Bun's official Next guide explicitly runs Next development and production servers
with Bun. More concretely, Bun 1.3.14's `node:http` server implementation calls
`Bun.serve` internally. The adapter's name alone therefore does not establish the
runtime. Verify `process.versions.bun` and the actual process executable in a
runtime probe.

Sources: [Bun's Next guide](https://bun.sh/guides/ecosystem/nextjs),
[Bun 1.3.14 HTTP server source](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/node/_http_server.ts#L456-L495).

The smallest public-API candidate remains a single Bun process hosting Hono through
the Node HTTP adapter, then giving Next the same request/response objects. It is
not a second HTTP server or a network proxy. Set the adapter's
`overrideGlobalObjects: false` to retain Bun's native `Request` and `Response`
instead of replacing both globals. This is an integration precaution supported by
the adapter's documented option, not proof that every default configuration fails.
Next 16.3.4's `getRequestHandler()` installs the upgrade listener on the supplied
`httpServer` or `req.socket.server`; avoid installing duplicate Next upgrade
handlers. HMR still needs a browser/runtime test on the pinned versions.

Sources: [Hono global-object option](https://github.com/honojs/node-server#overrideglobalobjects),
[Next 16.3.4 custom-server implementation](https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/next.ts),
[Next custom-server options](https://nextjs.org/docs/app/guides/custom-server).

Calling `Bun.serve({ fetch: app.fetch })` directly is a different composition:
Next's public custom-server handler accepts `IncomingMessage` and `ServerResponse`,
not a Web `Request` returning `Response`. No maintained public bridge for that
handoff was established in this search. A 2023 Bun/Elysia/Next demonstration uses
nonstandard request/response construction and internal Bun socket symbols for HMR;
it reports Bun 1.0.4 and Next 13.5.4, so it is not evidence of Next 16 compatibility.
The reviewed Bun 1.3.14 source has already changed those internals.

Sources: [Next handler types and implementation](https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/next.ts),
[Bun native fetch server](https://bun.sh/docs/runtime/http/server),
[original Bun/Next proof of concept](https://gist.github.com/ItzDerock/857253fcaa113742a29220a85e525c23),
[Bun 1.3.14 incoming request implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/node/_http_incoming.ts).

WebSocket compatibility cannot be inferred from successful HTML responses: Bun has
tracked Node HTTP upgrade/socket compatibility failures, including a report on
1.3.10. That report does not prove the Next HMR path fails on 1.3.14. Test actual
HMR connection, file-change updates, and shutdown rather than treating old issues
or Bun's current rolling documentation as the result for Lore's pinned versions.
Next's custom-server packaging constraint and the separate Cloudflare/workerd
entry still apply when the self-host runtime is Bun.

Source: [Bun HTTP upgrade report](https://github.com/oven-sh/bun/issues/28157).

## Bun runtime probe results

An isolated fixture was tested on macOS with Bun 1.3.14, Next 16.3.4, React
19.2.8, Hono 4.13.8, and `@hono/node-server` 2.0.12. Next/React/Hono versions
match the packages currently installed in Lore. The shell's default Bun is 1.3.6,
so the probe used a separate official 1.3.14 binary downloaded into its temporary
directory; the global runtime and Lore dependencies were not changed.

The entry runs with `bun server.ts`. It creates one `node:http` server using
Hono's `getRequestListener(app.fetch, { overrideGlobalObjects: false })`, supplies
that server as Next's `httpServer`, registers Hono endpoints, then invokes
`await nextHandler(c.env.incoming, c.env.outgoing)` in the final fallback and
returns `RESPONSE_ALREADY_SENT`. Use `Hono<{ Bindings: HttpBindings }>` for the
raw request/response types. Creating the HTTP server explicitly avoids the
adapter factory's HTTP/HTTP2 union type conflicting with Next's HTTP server type.

Observed results on 2026-09-17:

- Development: Hono liveness and JSON POST endpoints returned 200; the Next
  server-rendered page displayed Bun 1.3.14 and the same process ID.
- Browser Fast Refresh: a newly added client component appeared without a manual
  reload. After clicking its counter to 1, editing its label changed the visible
  button from `counter-before 1` to `counter-after 1`, preserving React state.
- Production: running Next's build CLI through Bun passed compilation and
  TypeScript checking. Starting the custom entry with `NODE_ENV=production`
  returned 200 for SSR HTML, a JavaScript asset, and a JSON POST to Hono.
- Process inspection: the production executable was the isolated Bun binary;
  Hono and SSR reported the same PID, with one listener on `127.0.0.1:43187`.
- Both temporary servers were stopped after verification.

The fixture lives at `/private/tmp/lore-bun-next-tiuu9l_o` for this local session.
These are direct runtime/browser observations, not claims derived from framework
documentation. This proves the basic composition and Fast Refresh on these
versions. It does not yet validate Lore's authentication, PostgreSQL, providers,
streaming, Docker packaging, or Cloudflare deployment under a changed entry.
No Lore application or deployment files were modified by this probe.

## Implications for the alternative

It is reasonable to say “the community already does this” and point to the small
Node composition and the OpenNext Worker hook. It would be inaccurate to present
`hono-next` as a ready-made replacement for Lore's current full Next application,
or to promise that a new integration dependency preserves standalone packaging and
Cloudflare deployment unchanged. A change should first verify Lore's actual
rendering, authentication, request streaming, HMR, shutdown, and packaging on its
pinned versions. The alternative uses the official Node HTTP adapter and Next
custom-server API running under Bun. The isolated probe establishes basic
Bun/Next rendering, Fast Refresh, and production startup; adopting it would still
need the application and deployment checks listed above. Lore instead keeps the
Next-hosted `hono/vercel` integration selected above.
