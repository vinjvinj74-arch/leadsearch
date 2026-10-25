export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);

export const unauthorized = (message = 'Autenticacao necessaria.') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Acesso negado.') => new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Recurso nao encontrado.') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export const integrationNotConfigured = (message: string) =>
  new AppError(503, 'INTEGRATION_NOT_CONFIGURED', message);

export const upstreamError = (message: string, details?: unknown) =>
  new AppError(502, 'UPSTREAM_ERROR', message, details);
