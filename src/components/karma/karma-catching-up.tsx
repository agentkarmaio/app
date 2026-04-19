export function KarmaCatchingUp({
  title = 'The karma feed is catching up',
  message = "We're reconnecting to the on-chain index. Refresh in a moment.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] p-10 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgb(245_166_35/0.08),transparent_55%)]"
      />
      <div className="relative">
        <div className="karma-catching-wrap mx-auto size-10">
          <span className="karma-catching-ring" />
          <span className="karma-catching-ring" />
          <span className="karma-catching-core" />
        </div>
        <p className="karma-catching-title mt-5 text-[15px] font-[510] text-[#f7f8f8]">
          {title}
        </p>
        <p className="mt-1.5 text-[13px] text-[#8a8f98]">{message}</p>
      </div>
    </div>
  );
}
