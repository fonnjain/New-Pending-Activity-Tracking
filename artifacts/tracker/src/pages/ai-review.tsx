import { useTracker } from "@/lib/store";
import { AiReviewPanel } from "@/components/ai-review-panel";
import { EmptyState } from "@/pages/overview";

export default function AiReviewView() {
  const { selectedImportId } = useTracker();

  if (!selectedImportId) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Review</h1>
        <p className="text-muted-foreground text-sm mt-1">
          An advisory audit of the computed results for the selected import. The deterministic
          engine remains the source of truth; AI findings are suggestions only.
        </p>
      </div>
      <AiReviewPanel importId={selectedImportId} />
    </div>
  );
}
