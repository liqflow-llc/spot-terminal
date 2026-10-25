/** Token safety warnings, shown just above the order button. */
export default function TokenRiskNote({ warnings }) {
  if (!warnings?.length) return null;
  const danger = warnings.some(w => w.level === 'danger');
  return (
    <div className={`of-note ${danger ? 'danger' : 'warn'} risk-note`} role="alert">
      <strong>{danger ? '⚠ Risky token. Check before trading:' : 'Check before trading:'}</strong>
      <ul>{warnings.map(w => <li key={w.text}>{w.text}</li>)}</ul>
    </div>
  );
}
