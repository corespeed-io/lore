declare module "*.open-next/worker.js" {
  const worker: {
    fetch: ExportedHandlerFetchHandler<CloudflareEnv>;
  };
  export default worker;

  export const BucketCachePurge: unknown;
  export const DOQueueHandler: unknown;
  export const DOShardedTagCache: unknown;
}
