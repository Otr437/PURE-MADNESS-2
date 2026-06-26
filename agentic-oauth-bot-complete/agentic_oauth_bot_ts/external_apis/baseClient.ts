// external_apis/baseClient.ts — Shared axios instance for external API calls.
// All external API clients extend this with their own auth headers.

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from '../api/middleware';

export function createApiClient(baseURL: string, defaultHeaders: Record<string, string> = {}): AxiosInstance {
  const client = axios.create({
    baseURL,
    headers: { 'Content-Type': 'application/json', ...defaultHeaders },
    timeout: 15_000,
  });

  client.interceptors.request.use(req => {
    logger.debug('External API request', { method: req.method?.toUpperCase(), url: req.url });
    return req;
  });

  client.interceptors.response.use(
    res => res,
    err => {
      if (axios.isAxiosError(err)) {
        logger.error('External API error', {
          url:    err.config?.url,
          status: err.response?.status,
          data:   err.response?.data,
        });
      }
      return Promise.reject(err);
    },
  );

  return client;
}
