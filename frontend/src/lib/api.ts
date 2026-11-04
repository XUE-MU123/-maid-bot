// CSRF lives only in memory. Authentication itself is an HttpOnly server cookie.
let csrfToken = '';
export function setAuthToken(value: string) { csrfToken = value; }
export function clearAuthToken() { csrfToken = ''; }
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (!path.startsWith('/api/') || path.includes('://') || path.includes('\\')) throw new Error('接口路径不合法');
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method, credentials: 'same-origin', signal: options.signal,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('面板响应异常，请刷新页面或检查登录状态'); }
  if (response.status === 401 && (!path.startsWith('/api/auth/') || path === '/api/auth/logout')) {
    clearAuthToken(); window.dispatchEvent(new Event('maid-auth-expired'));
  }
  if (!response.ok) throw new Error((data as { error?: string }).error || `请求失败（${response.status}）`);
  return data as T;
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';
