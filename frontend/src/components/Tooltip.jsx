import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

/**
 * Hover (or tap, on touch screens) to show a short explanation. Drawn in a portal with fixed
 * positioning so panels that clip their overflow (the book footer, the header strip) can't hide it.
 */
export default function Tooltip({ text, children, className = '', underline = true }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null); // { x, y, below }

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top < 90; // no room above: open downwards
    setPos({ x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
  };
  const hide = () => setPos(null);

  // A tap elsewhere or any scroll closes it (touch screens have no mouse-leave).
  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) hide(); };
    document.addEventListener('pointerdown', close);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', hide, true);
    };
  }, [pos]);

  if (!text) return children;
  return (
    <span
      ref={ref}
      className={`tip-anchor ${underline ? 'tip-underline' : ''} ${className}`}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={() => (pos ? hide() : show())}
    >
      {children}
      {pos && createPortal(
        <span
          role="tooltip"
          className={`tip ${pos.below ? 'below' : ''}`}
          style={{ left: Math.min(Math.max(pos.x, 136), window.innerWidth - 136), top: pos.y }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
