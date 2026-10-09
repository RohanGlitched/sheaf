import { launchMetadata } from "../metadata";

export const dynamic = "force-dynamic";

/**
 * Token metadata by basket: the URI of the first launches (BIG5A, FRNTRA,
 * PROXYA, IDXA), which are immutable. It describes the basket's official
 * launch and names its mint, so another token pointing here is told apart.
 * Launches opened since point at `/api/launch/<basket>/<slot>`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return launchMetadata(req, address, null);
}
