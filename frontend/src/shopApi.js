export async function shopApi(path, options = {}, csrfToken) {
  const response = await fetch(`/shop-api${path}`, {
    cache: 'no-store',
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken || '',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof value.detail === 'string' ? value.detail : `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return value;
}
