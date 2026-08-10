import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GraphScalePrototype, type PrototypeVariant } from "@/components/WorkerCanvasGraph";

// PROTOTYPE — three rendering architectures for a 5,000-node / 20,000-link graph,
// switchable via ?variant=canvas|worker|svg on /prototype/graph-scale.
export default async function GraphScalePrototypePage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  await connection();
  const requested = (await searchParams).variant;
  const initialVariant: PrototypeVariant =
    requested === "worker" || requested === "svg" ? requested : "canvas";
  return <GraphScalePrototype initialVariant={initialVariant} />;
}
