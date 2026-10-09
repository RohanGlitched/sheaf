import type { Metadata } from "next";
import { PredictIndex } from "@/components/predict-index";

export const metadata: Metadata = {
  title: "Predict",
  description:
    "A Panta prediction market on every Sheaf basket: will it beat SPY this week? Resolved from a vault value anyone can recompute.",
};

export default function PredictPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-24 sm:px-8">
      <PredictIndex />
    </div>
  );
}
