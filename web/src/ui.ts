// Shared className constants for the design-system reskin (see claude.ai/design
// project "Claude Multi-Instance"). Centralized here so every modal/screen picks
// up style changes from one place instead of redefining these strings per file.

export const cardClassName: string =
  "flex flex-col gap-[18px] rounded-lg border border-border bg-surface p-[24px] shadow-modal";

export const inputClassName: string =
  "w-full rounded-sm border border-border-strong bg-app px-[11px] py-[9px] font-mono text-[12.5px] text-txt-body outline-none focus:border-accent-border disabled:opacity-50";

export const inputErrorClassName: string = `${inputClassName} border-diff-removed-border bg-diff-removed-dim`;

export const fieldLabelClassName: string =
  "mb-[6px] block text-[11px] font-semibold uppercase tracking-[.02em] text-txt-bright";

export const errorTextClassName: string = "flex items-center gap-[5px] text-[11px] text-diff-removed";

export const hintTextClassName: string = "mt-[5px] text-[11px] text-txt-dimmer";

const btnBase: string =
  "rounded-sm px-[16px] py-[9px] text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export const btnGhost: string = `${btnBase} border border-transparent bg-transparent text-txt-secondary hover:bg-raised hover:text-txt-bright`;

export const btnOutline: string = `${btnBase} border border-border-strong bg-transparent text-txt-secondary hover:border-txt-dim hover:text-txt-bright`;

export const btnPrimary: string = `${btnBase} border border-accent bg-accent text-on-accent hover:brightness-[1.06]`;

export const btnDanger: string = `${btnBase} border border-diff-removed bg-diff-removed text-on-accent hover:brightness-[1.06]`;
