interface EmptyStateProps {
  onNewInstance: () => void;
}

export function EmptyState({ onNewInstance }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[18px]">
      <span className="text-[15px] text-txt-dim">No active instances</span>
      <button
        type="button"
        onClick={onNewInstance}
        className="rounded-[6px] bg-accent px-[18px] py-[9px] text-[13px] font-semibold text-on-accent"
      >
        New instance
      </button>
    </div>
  );
}
