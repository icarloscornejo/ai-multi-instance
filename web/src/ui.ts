// Shared className constants for the AI Multi-Instance design system. Centralized
// here so every modal/screen picks
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

// El primario ya no es naranja: es tinta solida (negro sobre blanco en claro, blanco sobre
// negro en oscuro), sin borde propio.
export const btnPrimary: string = `${btnBase} bg-accent text-on-accent hover:brightness-[1.08]`;

// Secundario tipo "Cancel"/"Add"/acciones del mock: borde suave sobre superficie elevada, sin
// relleno de tinta.
export const btnSecondary: string = `${btnBase} border border-border-strong bg-raised text-txt-body hover:border-txt-dim hover:text-txt-bright`;

export const btnDanger: string = `${btnBase} border border-diff-removed bg-diff-removed text-on-accent hover:brightness-[1.06]`;

export const iconBtnClassName: string =
  "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm border border-border bg-surface text-txt-dim transition-colors hover:bg-raised hover:text-txt-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface disabled:hover:text-txt-dim";

// Control segmentado (Light / Dark / System, y variantes similares). segmentedClassName va en
// el contenedor; segmentedButtonClassName(selected) en cada boton.
export const segmentedClassName: string = "flex gap-[3px] rounded-md bg-raised-2 p-[3px]";

export function segmentedButtonClassName(selected: boolean): string {
  const base = "h-[30px] rounded-sm px-[14px] text-[12px] font-medium transition-colors";
  return selected
    ? `${base} bg-surface text-txt-bright shadow-[0_1px_4px_rgba(0,0,0,.08)]`
    : `${base} bg-transparent text-txt-secondary hover:text-txt-bright`;
}

export function formatCountdown(ms: number): string {
  const totalSeconds: number = Math.max(0, Math.ceil(ms / 1000));
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}
