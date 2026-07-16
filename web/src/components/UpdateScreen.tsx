import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { UpdateStatus } from "../types";
import { btnGhost, btnOutline, btnPrimary, cardClassName } from "../ui";

interface UpdateScreenProps {
  initialStatus: UpdateStatus | null;
  onStatusChange: (status: UpdateStatus) => void;
  onClose: () => void;
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function SkeletonLine({ widthClassName }: { widthClassName: string }) {
  return <div className={`h-[11px] animate-pulse rounded-[4px] bg-raised-2 ${widthClassName}`} />;
}

function CommitBlock({
  label,
  hash,
  subject,
  highlighted,
}: {
  label: string;
  hash: string | null;
  subject: string | null;
  highlighted: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-[6px] rounded-md border p-[14px] ${
        highlighted ? "border-accent-border bg-accent-dim" : "border-border bg-app"
      }`}
    >
      <span
        className={`w-fit rounded-full px-[9px] py-[2px] text-[10.5px] font-bold uppercase tracking-[.03em] ${
          highlighted ? "bg-accent text-on-accent" : "bg-raised-2 text-txt-secondary"
        }`}
      >
        {label}
      </span>
      {hash === null ? (
        <>
          <SkeletonLine widthClassName="w-[70px]" />
          <SkeletonLine widthClassName="w-[90%]" />
        </>
      ) : (
        <>
          <span className="font-mono text-[13px] text-txt-bright">{shortHash(hash)}</span>
          <span className="text-[11.5px] leading-[1.45] text-txt-secondary">{subject}</span>
        </>
      )}
    </div>
  );
}

export function UpdateScreen({ initialStatus, onStatusChange, onClose }: UpdateScreenProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(initialStatus);
  const [phase, setPhase] = useState<"checking" | "applying" | "idle">("checking");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runCheck = (): void => {
    setPhase("checking");
    setErrorMessage(null);
    api
      .checkForUpdate()
      .then((result) => {
        setStatus(result);
        onStatusChange(result);
        setPhase("idle");
      })
      .catch((error) => {
        setErrorMessage(error instanceof ApiError ? error.message : "Could not check for updates.");
        setPhase("idle");
      });
  };

  useEffect(() => {
    runCheck();
    // Only on mount: a fresh check every time the screen opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const runApply = (): void => {
    setPhase("applying");
    setErrorMessage(null);
    api
      .applyUpdate()
      .then((result) => {
        setStatus(result);
        onStatusChange(result);
        setPhase("idle");
      })
      .catch((error) => {
        setErrorMessage(error instanceof ApiError ? error.message : "Could not apply the update.");
        setPhase("idle");
      });
  };

  const busy: boolean = phase === "checking" || phase === "applying";
  const checking: boolean = phase === "checking";

  return (
    <div className="flex h-screen items-center justify-center">
      <div className={`w-[580px] ${cardClassName}`}>
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-bold text-txt-bright">Update</h1>
          <button type="button" onClick={onClose} className={btnGhost}>
            Close
          </button>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-[10px]">
          <CommitBlock
            label="Current"
            hash={checking ? null : status?.currentCommit ?? null}
            subject={status?.currentSubject ?? null}
            highlighted={false}
          />
          <div className="flex items-center justify-center text-[16px] text-txt-dim">→</div>
          <CommitBlock
            label="Latest"
            hash={checking ? null : status?.remoteCommit ?? null}
            subject={status?.remoteSubject ?? null}
            highlighted
          />
        </div>

        {errorMessage !== null && (
          <div className="rounded-sm border border-diff-removed-border bg-diff-removed-dim px-[12px] py-[10px] text-[11.5px] text-txt-body">
            ⚠ {errorMessage}
          </div>
        )}

        {status !== null && !checking && status.lastError !== null && (
          <div className="rounded-sm border border-diff-removed-border bg-diff-removed-dim px-[12px] py-[10px] text-[11.5px] text-txt-body">
            ⚠ {status.lastError}
          </div>
        )}

        {status !== null && !checking && status.blockedReason !== null && (
          <div className="rounded-sm border border-diff-removed-border bg-diff-removed-dim px-[12px] py-[10px] text-[11.5px] text-txt-body">
            ⚠ {status.blockedReason}
          </div>
        )}

        <div>
          <div className="mb-[8px] text-[11px] font-bold uppercase tracking-[.03em] text-txt-dim">What's new</div>
          <div className="max-h-[170px] overflow-y-auto rounded-md border border-border">
            {checking &&
              [0, 1, 2].map((key) => (
                <div key={key} className="flex items-center gap-[10px] border-b border-border px-[12px] py-[9px] last:border-b-0">
                  <SkeletonLine widthClassName="w-[56px]" />
                  <SkeletonLine widthClassName="w-[56px]" />
                  <div className="flex-1">
                    <SkeletonLine widthClassName="w-full" />
                  </div>
                </div>
              ))}
            {!checking && status !== null && status.updateAvailable && status.changelog.length > 0 && (
              status.changelog.map((entry) => (
                <div key={entry.hash} className="flex gap-[10px] items-baseline border-b border-border px-[12px] py-[9px] last:border-b-0">
                  <span className="shrink-0 font-mono text-[11.5px] text-txt-dim">{entry.shortHash}</span>
                  <span className="shrink-0 text-[11px] text-txt-dimmer">{entry.date}</span>
                  <span className="text-[12px] text-txt-body">{entry.subject}</span>
                </div>
              ))
            )}
            {!checking && (status === null || !status.updateAvailable) && (
              <div className="px-[12px] py-[9px] text-[12px] text-txt-dim">
                {status?.pendingRestart ? "Already applied, no newer commits yet." : "Up to date."}
              </div>
            )}
          </div>
        </div>

        {status !== null && !checking && status.pendingRestart && (
          <div className="text-[11.5px] text-accent">
            {status.restartKind === "auto"
              ? "Only server/web code changed: tsx watch and Vite already hot-reloaded it. Reload this page to run the new frontend."
              : "Stop npm run dev with Ctrl+C and run it again to apply the new version. tmux sessions are preserved."}
          </div>
        )}

        <div className="flex justify-end gap-[10px]">
          <button type="button" onClick={runCheck} disabled={busy} className={btnOutline}>
            Check again
          </button>
          {status !== null && status.updateAvailable && (
            <button type="button" onClick={runApply} disabled={busy} className={btnPrimary}>
              {phase === "applying" ? "Applying..." : "Apply update"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
