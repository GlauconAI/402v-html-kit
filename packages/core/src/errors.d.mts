export declare class ArtifactBuildError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    details?: unknown,
    options?: ErrorOptions,
  );

  toJSON(): {
    ok: false;
    error: {
      code: string;
      message: string;
      details?: unknown;
    };
  };
}
