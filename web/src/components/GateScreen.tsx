import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";

interface GateScreenProps {
  onUnlocked: () => void;
}

// Deliberately minimal per the user's own spec: background color, a password input,
// a "Go" button. No card, no logo, nothing worth reading before the password is right.
export function GateScreen({ onUnlocked }: GateScreenProps) {
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      onUnlocked();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-app">
      <form onSubmit={handleSubmit} className="flex w-[260px] flex-col items-stretch gap-3">
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          className="rounded-md border border-border-strong bg-surface px-3 py-2 text-[14px] text-txt-bright outline-none focus:border-accent-border"
        />
        {error !== null && <div className="text-[12px] text-diff-removed">{error}</div>}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="rounded-md bg-accent px-3 py-2 text-[14px] font-medium text-on-accent disabled:opacity-50"
        >
          Go
        </button>
      </form>
    </div>
  );
}
