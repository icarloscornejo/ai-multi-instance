import { prEventsCheckboxText, prEventsStatusDot, prEventsStatusLabel } from "../prEvents";
import type { Instance, PrEventsResponse, UpdateInstancePayload } from "../types";

interface PrEventsControlProps {
  instance: Instance;
  info: PrEventsResponse[string] | undefined;
  onUpdate: (instanceId: string, payload: UpdateInstancePayload) => void;
  sizeClass: string;
}

// Shared by the desktop inspector and the phone settings sheet so both offer the same opt-in,
// pause switch and status line. Only Claude agents in a real session can receive the paste.
export function PrEventsControl({ instance, info, onUpdate, sizeClass }: PrEventsControlProps) {
  if (instance.shellOnly === true || instance.provider !== "claude") {
    return <div className={`${sizeClass} text-txt-dimmer`}>Only available for Claude instances.</div>;
  }
  const enabled: boolean = instance.prEvents?.enabled === true;
  const paused: boolean = instance.prEvents?.paused === true;
  const { label, hint } = prEventsStatusLabel(info?.status ?? "off", info?.provider, info?.host);
  const pending: number = info?.pending ?? 0;

  return (
    <div className={`flex flex-col gap-[8px] ${sizeClass}`}>
      <label className="flex items-center gap-[8px] text-txt-body">
        <input
          type="checkbox"
          className="accent-accent"
          checked={enabled}
          onChange={(event) => onUpdate(instance.id, { prEvents: { enabled: event.target.checked } })}
        />
        {prEventsCheckboxText(info?.provider)}
      </label>
      {enabled && (
        <label className="flex items-center gap-[8px] text-txt-body">
          <input
            type="checkbox"
            className="accent-accent"
            checked={paused}
            onChange={(event) => onUpdate(instance.id, { prEvents: { paused: event.target.checked } })}
          />
          Pause delivery
        </label>
      )}
      <div className="flex items-center gap-[6px] text-txt-secondary">
        <span aria-hidden="true" className={`h-[8px] w-[8px] shrink-0 rounded-full ${prEventsStatusDot(info?.status ?? "off")}`} />
        Status: {label}
        {pending > 0 && ` (${pending} pending)`}
      </div>
      {hint !== null && enabled && <div className="text-status-warn">{hint}</div>}
    </div>
  );
}
