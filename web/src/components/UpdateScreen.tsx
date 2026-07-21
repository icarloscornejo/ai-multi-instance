import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { UpdateStatus } from "../types";
import { btnGhost, btnPrimary, cardClassName, iconBtnClassName } from "../ui";

interface UpdateScreenProps {
  initialStatus: UpdateStatus | null;
  autoApply?: boolean;
  onStatusChange: (status: UpdateStatus) => void;
  onClose: () => void;
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function SkeletonLine({ widthClassName }: { widthClassName: string }) {
  return <div className={`skel h-[11px] ${widthClassName}`} />;
}

function StatusLine({
  checking,
  couldNotCheck,
  updateAvailable,
  changelogCount,
  currentVersion,
  onRetry,
}: {
  checking: boolean;
  couldNotCheck: boolean;
  updateAvailable: boolean;
  changelogCount: number;
  currentVersion: string | null;
  onRetry: () => void;
}) {
  if (checking) {
    return (
      <div className="flex items-center gap-[8px] text-[11.5px] text-txt-secondary">
        <span className="spinner" />
        Comparing your version against the latest release
      </div>
    );
  }
  if (couldNotCheck) {
    return (
      <div className="flex items-center gap-[8px] text-[11.5px] text-txt-body">
        <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-diff-removed text-[10px] font-bold text-on-accent">
          !
        </span>
        No connection.{" "}
        <button type="button" onClick={onRetry} className="font-semibold text-accent">
          Retry
        </button>
      </div>
    );
  }
  if (!updateAvailable) {
    return (
      <div className="flex items-center gap-[8px] text-[11.5px] text-txt-body">
        <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-diff-added text-[10px] font-bold text-on-accent">
          ✓
        </span>
        You're on the latest version{currentVersion !== null ? ` (${shortHash(currentVersion)})` : ""}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-[6px] text-[11.5px] font-semibold text-accent">
      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
      {changelogCount} {changelogCount === 1 ? "commit" : "commits"} behind
    </div>
  );
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

export function UpdateScreen({ initialStatus, autoApply = false, onStatusChange, onClose }: UpdateScreenProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(initialStatus);
  const [phase, setPhase] = useState<"checking" | "applying" | "idle">(autoApply ? "applying" : "checking");
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

  useEffect(() => {
    // Update now, from the banner or popover, already knows an update is pending,
    // so it jumps straight to applying instead of re-checking first
    if (autoApply) {
      runApply();
    } else {
      runCheck();
    }
    // Only on mount: either a fresh check or an immediate apply, once per time the screen opens
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

  const busy: boolean = phase === "checking" || phase === "applying";
  const checking: boolean = phase === "checking";
  const couldNotCheck: boolean = !checking && errorMessage !== null;

  return (
    <div className="flex h-screen items-center justify-center">
      <div className={`w-[580px] ${cardClassName}`}>
        <div className="flex items-center gap-[8px]">
          <h1 className="text-[15px] font-bold text-txt-bright">Update</h1>
          <button type="button" onClick={runCheck} disabled={busy} title="Check again" className={iconBtnClassName}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[14px] w-[14px]">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
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

        <StatusLine
          checking={checking}
          couldNotCheck={couldNotCheck}
          updateAvailable={status?.updateAvailable === true}
          changelogCount={status?.changelog.length ?? 0}
          currentVersion={status?.currentCommit ?? null}
          onRetry={runCheck}
        />

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
          <button type="button" onClick={onClose} disabled={busy} className={btnGhost}>
            Close
          </button>
          {status !== null && status.updateAvailable && (
            <button type="button" onClick={runApply} disabled={busy} className={`${btnPrimary} flex items-center gap-[7px]`}>
              {phase === "applying" && <span className="spinner spinner-on-accent h-[12px] w-[12px]" />}
              {phase === "applying" ? "Applying update..." : "Apply update"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
