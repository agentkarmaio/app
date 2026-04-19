export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="h-8 w-32 animate-pulse rounded bg-[rgb(255_255_255/0.04)]" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-[rgb(255_255_255/0.03)]" />
      </div>
    </div>
  );
}
