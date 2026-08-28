// Ambient types for the dashboard's shared helpers (imported by tests only).
export interface AuthUser {
  ownerId: string;
  isAdmin: boolean;
}
export function login(token: string): Promise<AuthUser & { ok: boolean }>;
export function logout(): Promise<void>;
export function currentUser(): Promise<AuthUser | null>;
export function api(path: string, opts?: Record<string, unknown>): Promise<unknown>;
export function sse(
  url: string,
  onEvent: (type: string, data: unknown) => void,
  onError?: (err: Error) => void,
): () => void;
export function fmtTime(iso: string | null): string;
export function fmtDuration(startIso: string | null, endIso: string | null): string;
export function esc(s: unknown): string;
export function statusClass(status: string): string;
export function repoLabel(repo: { localPath?: string; url?: string } | null): string;
export function shortId(id: string): string;
export function pretty(v: unknown): string;
