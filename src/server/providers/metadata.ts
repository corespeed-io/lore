/** Model provenance and execution settings recorded by OSS diagnostics and benchmarks. */
export interface ModelProviderMetadata {
  provider: string;
  model: string;
  revision?: string;
  transport?: string;
  instruction?: string;
  decoding?: Record<string, unknown>;
  keepAlive?: string | number;
}
