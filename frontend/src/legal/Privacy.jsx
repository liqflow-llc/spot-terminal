import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import TopBar from '../components/TopBar.jsx';
import { BRAND, SITE } from '../brand';
import { ACCESS_LOG_DAYS, CONTACT_EMAIL, LEGAL_UPDATED, OPERATOR, OPERATOR_KIND } from './legalMeta';
import './Legal.css';

// Privacy Policy, modelled on LiqFlow's and w2w-chat's. Every claim describes what the code
// does: backend/src/server.js (no request logging; IPs only in in-memory rate limits),
// backend/src/orders/orderStore.js (what is stored per order), backend/src/orders/ledger.js (the
// record behind tax reports), nginx's default access log, and
// the browser storage below. If those change, this changes.

const STORAGE = [
  ['walletName', 'localStorage', 'Which wallet you connected, so it reconnects next time.', 'Until you disconnect'],
  ['spot.favoriteMarkets', 'localStorage', 'Markets you starred.', 'Until you clear it'],
  ['spot.theme', 'localStorage', 'Your light or dark theme choice (only if you change it from System).', 'Until you clear it'],
  ['tradingview.*', 'localStorage', 'Chart settings you change (indicators, chart type).', 'Until you clear it'],
  ['sw.js (service worker)', 'Service worker', 'Shows order notifications; installed only if you turn them on.', 'Until you clear site data'],
  ['spot.quoteFilter', 'localStorage', 'The SOL / USDC pairs filter you picked.', 'Until you clear it'],
];

export default function Privacy() {
  useEffect(() => { document.title = `Privacy Policy · ${BRAND}`; }, []);
  return (
    <div className="app legal-page">
      <TopBar />
      <main className="legal-main">
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: {LEGAL_UPDATED}</p>

        <p className="legal-callout">
          <strong>The short version.</strong> There are no accounts, no email addresses and
          <strong> no cookies</strong>. The Service knows your public wallet address while you use it
          and keeps a record of orders placed through it. Nothing is sold or shared for advertising.
        </p>

        <h2>1. Who runs this</h2>
        <p>
          {BRAND} ({SITE}) is run by {OPERATOR} &mdash; {OPERATOR_KIND}. For any privacy question or
          request, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>

        <h2>2. What is collected</h2>
        <h3>When you connect a wallet</h3>
        <p>
          Your <strong>wallet address</strong> is sent to the server to show your balances, orders
          and payout accounts and to prepare the transactions you sign. Wallet addresses and
          everything they do on Solana are public on the blockchain anyway.
        </p>
        <h3>When you place, cancel or pay out an order</h3>
        <ul>
          <li>Your wallet address, the market, side, price, size and status of the order</li>
          <li>The transactions involved, including the payout transaction you signed, which the
            Service must keep to pay your order out</li>
          <li>The payout accounts created for your wallet</li>
          <li>For your tax reports: the amounts each of these transactions moved between your wallet
            and SpotBook, and when your orders filled</li>
        </ul>
        <h3>If you turn on notifications</h3>
        <p>
          Your browser gives the Service an anonymous push address (a long URL at your browser
          maker&apos;s push service). It is stored with your wallet address so order updates (filled
          and paid out, expired, needs attention) reach you. Turning notifications off deletes it.
        </p>
        <h3>When you simply browse</h3>
        <ul>
          <li>The web server keeps standard access logs (IP address, page requested, browser
            user-agent, time) for {ACCESS_LOG_DAYS} days.</li>
          <li>To limit abuse, the app counts requests per IP address in memory for a minute or
            two. These counts are never written to disk.</li>
          <li>Two cookieless analytics services count visits, described in section 4.</li>
        </ul>

        <h2>3. What never happens here</h2>
        <ul>
          <li>No cookies, no advertising, no cross-site tracking, no selling of data</li>
          <li>No attempt to identify the person behind a wallet address</li>
          <li>Your private keys and seed phrase never reach the Service. Your wallet signs locally</li>
        </ul>

        <h2>4. Who else sees your data</h2>
        <ul>
          <li><strong>Cloudflare</strong> &mdash; sits in front of the site to serve it and block
            attacks, and provides Cloudflare Web Analytics (cookieless page-view counts).</li>
          <li><strong>Plausible Analytics</strong> &mdash; cookieless, aggregate visit statistics. It
            does not store IP addresses or build profiles.</li>
          <li><strong>Token icon hosts</strong> &mdash; token logos load directly from wherever each
            token&apos;s creator hosts them, which sees your IP address (no referrer is sent).</li>
          <li><strong>Helius</strong> &mdash; the Solana RPC provider the server uses; it receives the
            wallet addresses and transactions the server looks up or sends for you.</li>
          <li><strong>The Solana network</strong> &mdash; every transaction you sign is public,
            permanently.</li>
          <li><strong>Your browser&apos;s push service</strong> (Google for Chrome, Mozilla for Firefox,
            Apple for Safari) &mdash; only if you turn on notifications; it delivers each notification&apos;s
            text to your device.</li>
          <li><strong>Your wallet provider</strong> (Phantom, Solflare, &hellip;) under its own
            privacy policy.</li>
        </ul>
        <p>
          Market data comes from Jupiter and GeckoTerminal, but only the server talks to them and
          it sends them no information about you. The servers are in the United States; using the
          Service from elsewhere means your data is processed there.
        </p>

        <h2>5. What is stored in your browser</h2>
        <p>
          There are <strong>no cookies</strong>. Your browser&apos;s local storage is used for the items
          below, and only once you use the feature. None are used for advertising or shared.
        </p>
        <div className="legal-scroll">
          <table className="legal-table">
            <thead><tr><th>Name</th><th>Type</th><th>What it does</th><th>Kept for</th></tr></thead>
            <tbody>
              {STORAGE.map(([name, type, purpose, life]) => (
                <tr key={name}><td className="legal-mono">{name}</td><td>{type}</td><td>{purpose}</td><td>{life}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>6. How long it is kept</h2>
        <ul>
          <li><strong>Order records</strong> &mdash; for as long as the Service runs, because they
            hold pending payouts, your order history and the record your tax reports are built from. They are included in the server&apos;s
            encrypted backups.</li>
          <li><strong>Access logs</strong> &mdash; {ACCESS_LOG_DAYS} days.</li>
          <li><strong>Notification push addresses</strong> &mdash; until you turn notifications off or
            your browser revokes them.</li>
          <li><strong>Anything on the blockchain</strong> &mdash; forever. No one can delete it.</li>
        </ul>

        <h2>7. Your rights</h2>
        <p>
          Depending on where you live (for example the EU, UK or California), you may have the
          right to access, correct, delete or export your personal data, and to object to its use.
          Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from anywhere and I will reply
          within 30 days. I can delete the off-chain records about your wallet once it has no open
          orders; I cannot change the blockchain. Personal data is not sold or shared as those terms
          are defined under the CCPA/CPRA. If you are in the UK or EU, the legal bases are
          performance of a contract (running your orders and payouts) and legitimate interests
          (security and basic analytics).
        </p>

        <h2>8. Security</h2>
        <p>
          The site is served over HTTPS and backups are encrypted. No system is perfectly secure;
          please never send a seed phrase or private key to anyone, including me.
        </p>

        <h2>9. Children</h2>
        <p>The Service is not for anyone under 18, and data from children is not knowingly collected.</p>

        <h2>10. Changes</h2>
        <p>If this policy changes, the &ldquo;Last updated&rdquo; date above changes and material changes will be noted on the site.</p>

        <h2>11. Contact</h2>
        <p><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>

        <p className="legal-foot">See also the <Link to="/terms">Terms of Service</Link>.</p>
      </main>
    </div>
  );
}
