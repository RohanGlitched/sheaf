import { launchMetadata } from "../../metadata";

export const dynamic = "force-dynamic";

/**
 * Token metadata for one launch slot: the URI every launch opened since
 * 9 October is minted with. It answers with the official metadata only when
 * this slot holds the basket's launch, and with "Not an official Sheaf launch"
 * and the reason for a squat, a refused pool, or a mint that borrows the URL.
 */
export async function GET(req: Request, { params }: { params: Promise<{ address: string; slot: string }> }) {
  const { address, slot } = await params;
  return launchMetadata(req, address, slot);
}
