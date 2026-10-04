import { useState } from 'react';

export default function TokenIcon({ token, size = 20 }) {
  const [failed, setFailed] = useState(false);
  const letter = (token?.symbol || '?').replace(/^\$/, '').charAt(0).toUpperCase();
  return (
    <span className="token-icon" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {letter}
      {token?.icon && !failed && (
        <img src={token.icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      )}
    </span>
  );
}
