// Custom loading shell so navigating into /deck doesn't briefly render the
// root pulse skeleton from app/loading.tsx — that visual mismatch was the
// "flicker" users were seeing. This matches the viewer's outer frame.

export default function DeckLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="aspect-[16/9] w-full rounded-lg border border-border bg-card" />
    </div>
  );
}
