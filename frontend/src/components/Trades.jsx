import { formatAmount, formatPrice, formatTime, priceDecimals } from '../utils/format';
import './Trades.css';
import './OrderBook.css'; // venue badge style
import { VENUE_INFO } from '../venues';
import Tooltip from './Tooltip.jsx';

export default function Trades({ trades, market, empty }) {
  const decimals = priceDecimals(market?.last ?? trades[0]?.price);
  return (
    <>
      <div className="panel-title"><span>Market trades</span></div>
      <div className="tr-head"><span>Price ({market?.quote.symbol || '—'})</span><span>Amount ({market?.base.symbol || '—'})</span><span>Time</span></div>
      <div className="tr-body">
        {!trades.length && <div className="tr-empty muted">{empty || 'No trades yet. New fills appear here live.'}</div>}
        {trades.map((t, i) => {
          const cells = (
            <>
              <span className={`num ${t.side === 'buy' ? 'bid' : 'ask'}`}>
                {formatPrice(t.price, decimals)}
                {t.venue === 'archer' && <Tooltip text={VENUE_INFO.archer} underline={false}><span className="venue-badge archer">A</span></Tooltip>}
              </span>
              <span className="num">{formatAmount(t.size)}</span>
              <span className="num muted">{formatTime(t.time)}</span>
            </>
          );
          // Trades are inferred from book snapshots, so most have no single transaction to link.
          return t.signature
            ? <a key={`${t.signature}${i}`} className="tr-row" href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer">{cells}</a>
            : <div key={`${t.time}-${i}`} className="tr-row">{cells}</div>;
        })}
      </div>
    </>
  );
}
