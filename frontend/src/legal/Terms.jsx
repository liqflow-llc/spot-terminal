import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import TopBar from '../components/TopBar.jsx';
import { BRAND, SITE } from '../brand';
import { setPageTitle } from '../pageTitle';
import { CONTACT_EMAIL, LEGAL_UPDATED, OPERATOR, OPERATOR_KIND } from './legalMeta';
import './Legal.css';

// Terms of Service, modelled on LiqFlow's (liq-heatmap/frontend/src/pages/Terms.jsx) and adapted
// to what this app does: a non-custodial interface that builds transactions for the user's
// wallet to sign, plus the automatic-payout service, the setup deposit and market creation.
//
// NOT legal advice and not reviewed by a lawyer.

export default function Terms() {
  useEffect(() => { setPageTitle(`Terms of Service · ${BRAND}`); }, []);
  return (
    <div className="app legal-page">
      <TopBar />
      <main className="legal-main">
        <h1>Terms of Service</h1>
        <p className="legal-updated">Last updated: {LEGAL_UPDATED}</p>

        <h2>1. Who runs this, and what it covers</h2>
        <p>
          {BRAND} is run by {OPERATOR} &mdash; {OPERATOR_KIND}. &ldquo;I&rdquo; and &ldquo;me&rdquo;
          below mean the operator. These Terms govern your use of {SITE} and its API (the
          &ldquo;Service&rdquo;). By using the Service, including by connecting a wallet or signing a
          transaction it prepares, you agree to these Terms. If you do not agree, do not use it.
        </p>
        <p>
          You must be at least 18 and legally able to enter into a contract. You are responsible
          for following the laws that apply to you, including any rules on trading digital assets.
          You may not use the Service if you are subject to sanctions, or located in or a resident
          of a country or region under comprehensive sanctions.
        </p>

        <h2>2. What {BRAND} is &mdash; and what it is not</h2>
        <p>
          {BRAND} is <strong>software that shows public on-chain order books and prepares
          transactions for your own wallet to sign</strong>. Orders are placed on Manifest, an
          independent on-chain order book program on the Solana blockchain that I do not own or
          control. Trades are matched by that program, not by me.
        </p>
        <p className="legal-callout">
          <strong>I never take custody of your funds.</strong> Nothing moves from your wallet unless
          you sign it. I am not an exchange, broker, dealer, money transmitter, investment adviser
          or fiduciary, and nothing on {BRAND} is financial, investment, trading, legal or tax advice.
        </p>

        <h2>3. Your wallet and your transactions</h2>
        <ul>
          <li>You are responsible for your wallet, its keys and its security. I will never ask for
            your seed phrase or private key; anyone who does is not me.</li>
          <li>Read what your wallet asks you to sign. Blockchain transactions are final: once
            confirmed they cannot be reversed, by me or anyone else.</li>
          <li>You are solely responsible for every order you place: its price, size and token,
            and any resulting gains or losses.</li>
        </ul>

        <h2>4. Automatic payouts</h2>
        <p>
          When you place an order, your wallet also signs a payout transaction that can only move
          that order&apos;s proceeds from Manifest to <strong>your own wallet</strong>. A service I run
          (the &ldquo;keeper&rdquo;) submits it when the order fully fills and pays its network fee.
          Cancelling an order voids its payout transaction.
        </p>
        <ul>
          <li>Payouts are <strong>best effort</strong>. They can be delayed or fail, for example if
            the Service is down, the network is congested, or the order is only partly filled.</li>
          <li>Your funds never depend on the keeper: anything left in a market can always be
            withdrawn by you with your own wallet, from the Balances tab.</li>
        </ul>

        <h2>5. The setup deposit</h2>
        <p>
          Your first order creates small payout accounts that your wallet controls, funded with a
          refundable SOL deposit (network rent). I never hold it. You can get it back at any time by
          closing your account on the <Link to="/account">Account page</Link>, which also cancels any
          open orders and returns their funds to your wallet.
        </p>

        <h2>6. Creating markets, and the tokens you trade</h2>
        <ul>
          <li>Anyone can create a Manifest market through the Service. The creator pays the network
            rent, which is <strong>not refundable</strong>, and creating a market does not make me
            responsible for it or for its token.</li>
          <li>Tokens are <strong>not vetted</strong>. Any token can be listed, including worthless,
            fraudulent or malicious ones. A &ldquo;verified&rdquo; mark only means the token is on
            Jupiter&apos;s verified list, not that I endorse it.</li>
          <li>New and small markets can have little or no liquidity. Your order may never fill.</li>
        </ul>

        <h2>7. Prices and warnings</h2>
        <p>
          The market prices, charts, volumes and order books shown come from the blockchain and
          third parties (including Jupiter and GeckoTerminal) and can be wrong, late or missing. The
          warning shown when an order is priced far from the market is a convenience, not a
          safeguard: it may not appear, and it may appear wrongly. Check every price yourself.
        </p>

        <h2>8. Fees</h2>
        <p>
          I charge no fee for trading through {BRAND}. You pay Solana network fees and rent for the
          transactions you sign. If I ever introduce a fee, it will be shown before you sign
          anything it applies to.
        </p>

        <h2>9. Risks you accept</h2>
        <ul>
          <li><strong>You may lose money, including all of it.</strong> Digital asset prices are
            volatile.</li>
          <li>Smart contracts, including Manifest and Solana itself, can have bugs or be exploited.
            The Service&apos;s own software can have bugs too.</li>
          <li>Networks can halt, congest or reorder transactions; wallets and RPC providers can
            fail.</li>
          <li>Laws and regulations about digital assets can change and may affect you.</li>
        </ul>

        <h2>10. No warranty</h2>
        <p>
          The Service is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;, with no
          warranty of any kind</strong>, express or implied, including any warranty of accuracy,
          availability, merchantability, fitness for a particular purpose or non-infringement. I
          may change, suspend or discontinue any part of it at any time, including while you have
          open orders; your orders stay on Manifest and remain yours to manage with any compatible
          tool.
        </p>

        <h2>11. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, I am not liable for any indirect, incidental,
          special, consequential, exemplary or punitive damages, or for any trading losses, lost
          profits, missed or delayed fills or payouts, or losses arising from smart contracts,
          networks, wallets, third-party data or tokens, however caused.
        </p>
        <p>
          To the fullest extent permitted by law, my total liability for all claims relating to the
          Service is limited to US$100. Some jurisdictions do not allow these limitations, so parts
          of this section may not apply to you.
        </p>

        <h2>12. Indemnity</h2>
        <p>
          You agree to indemnify and hold me harmless from claims, losses and expenses (including
          reasonable legal fees) arising from your use of the Service, your breach of these Terms,
          or your violation of any law or third-party right.
        </p>

        <h2>13. Acceptable use</h2>
        <p>
          Do not use the Service to break the law, to manipulate markets (for example spoofing or
          wash trading), to create markets for tokens designed to defraud people, or to overload or
          attack the Service. I may block access to the Service&apos;s website and API at any time.
        </p>

        <h2>14. Changes</h2>
        <p>
          I may update these Terms. The &ldquo;Last updated&rdquo; date above will change, and material
          changes will be noted on the site. Using the Service after a change means you accept it.
        </p>

        <h2>15. Governing law</h2>
        <p>
          These Terms are governed by the laws of the State of Florida, USA, without regard to its
          conflict-of-laws rules. Any dispute will be brought exclusively in the state or federal
          courts located in Florida, and you consent to their jurisdiction.
        </p>

        <h2>16. Contact</h2>
        <p><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>

        <p className="legal-foot">See also the <Link to="/privacy">Privacy Policy</Link>.</p>
      </main>
    </div>
  );
}
