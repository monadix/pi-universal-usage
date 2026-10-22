/**
 * Loader-health gate for the opt-in live smoke.
 *
 * The SDK service factory reports extension loading and provider registration
 * failures as diagnostics instead of rejecting. A built-in provider can remain
 * registered when its configured replacement fails, so provider-ID validation
 * is only meaningful after these errors are refused. The summary contains
 * counts and fixed categories only: never extension paths or error text.
 */

export interface LoaderDiagnostic {
  type: string;
}

export interface SmokeLoaderHealth {
  ok: boolean;
  extensionErrors: number;
  registrationErrors: number;
}

export function assessLoaderHealth(
  diagnostics: readonly LoaderDiagnostic[],
  extensionErrors: readonly unknown[],
): SmokeLoaderHealth {
  const registrationErrors = diagnostics.filter((diagnostic) => diagnostic.type === "error").length;
  return {
    ok: extensionErrors.length === 0 && registrationErrors === 0,
    extensionErrors: extensionErrors.length,
    registrationErrors,
  };
}

export function loaderFailureSummary(health: SmokeLoaderHealth): string {
  return (
    `loader failed (extensionErrors=${health.extensionErrors}, ` +
    `registrationErrors=${health.registrationErrors}); refusing provider validation`
  );
}
