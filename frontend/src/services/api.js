async function parse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const getJSON = (url) => fetch(url, { headers: { Accept: 'application/json' } }).then(parse);

export const postJSON = (url, data) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(data),
}).then(parse);
