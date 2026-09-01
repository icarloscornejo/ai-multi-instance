// Extracted from api.ts so launchSteps.ts (the NDJSON stream reader) can throw it without a
// circular import back through api.ts. api.ts re-exports it, so every existing
// `import { ApiError } from "./api"` keeps working unchanged.
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
