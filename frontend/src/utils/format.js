// Number formatting shared by every panel.

/** Decimal places that keep ~5 significant digits for a price of this size. */
export function priceDecimals(price) {
  if (!price || !isFinite(price)) return 2;
  const mag = Math.floor(Math.log10(Math.abs(price)));
  return Math.min(12, Math.max(2, 4 - mag));
}

export function formatPrice(value, decimals) {
  if (value == null || !isFinite(value)) return '—';
  const d = decimals ?? priceDecimals(value);
  return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function formatAmount(value, maxDecimals = 4) {
  if (value == null || !isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(2)}K`;
  const d = abs >= 100 ? 2 : abs >= 1 ? Math.min(maxDecimals, 4) : Math.min(8, Math.max(maxDecimals, priceDecimals(abs)));
  return value.toLocaleString('en-US', { maximumFractionDigits: d });
}

export function formatUsd(value) {
  if (value == null || !isFinite(value)) return '—';
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  if (value !== 0 && Math.abs(value) < 0.01) return `$${formatPrice(value)}`; // tiny token prices
  return `$${value.toFixed(2)}`;
}

export function formatPct(ratio) {
  if (ratio == null || !isFinite(ratio)) return '—';
  const pct = ratio * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDateTime(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export const shortAddress = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

/** Trim a number to the precision a token supports, as a plain string for inputs. */
export function toInputString(value, decimals) {
  if (!isFinite(value) || value <= 0) return '';
  return Number(value.toFixed(Math.min(decimals, 10))).toString();
}
