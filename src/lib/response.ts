import type { Response } from "express";

export type ApiSuccess<T> = {
  data: T;
  error: null;
  meta?: Record<string, unknown>;
};

export type ApiFailure = {
  data: null;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
  meta?: Record<string, unknown>;
};

export function sendOk<T>(res: Response, data: T, meta?: Record<string, unknown>) {
  const payload: ApiSuccess<T> = { data, error: null, ...(meta ? { meta } : {}) };
  return res.status(200).json(payload);
}

export function sendError(
  res: Response,
  status: number,
  message: string,
  code?: string,
  details?: unknown
) {
  const payload: ApiFailure = {
    data: null,
    error: {
      message,
      ...(code ? { code } : {}),
      ...(details !== undefined ? { details } : {})
    }
  };
  return res.status(status).json(payload);
}
