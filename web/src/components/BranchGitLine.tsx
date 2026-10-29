import { formatReview, formatUpstream, upstreamFor } from "../liveStatusFormatting";
import type { LiveStatus } from "../types";

interface BranchGitLineProps {
  liveStatus: LiveStatus | null;
  // The branch the panel is showing: the push state and the merge request are only drawn when
  // they were read for that same branch
  branch: string | undefined;
  // The font size, which is the only thing the desktop inspector and the mobile sheet differ on
  sizeClass: string;
}

// Under the branch name: whether it is pushed, and its merge/pull request when it has one.
export function BranchGitLine({ liveStatus, branch, sizeClass }: BranchGitLineProps) {
  const upstream = upstreamFor(liveStatus, branch);
  if (upstream === null) {
    return null;
  }
  const push = formatUpstream(upstream);
  const review = liveStatus?.review === undefined ? null : formatReview(liveStatus.review);

  return (
    <div className={`mt-[3px] flex flex-wrap items-center gap-x-[8px] font-mono ${sizeClass}`}>
      <span className={push.colorClass}>{push.text}</span>
      {review !== null &&
        (review.href !== null ? (
          <a
            href={review.href}
            target="_blank"
            rel="noopener noreferrer"
            title={review.title}
            className={`text-accent hover:underline${review.dimmed ? " opacity-60" : ""}`}
          >
            {review.text}
          </a>
        ) : (
          <span title={review.title} className={`text-txt-dim${review.dimmed ? " opacity-60" : ""}`}>
            {review.text}
          </span>
        ))}
    </div>
  );
}
