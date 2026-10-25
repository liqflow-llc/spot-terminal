import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { BRAND } from './brand';

// Backpack names the site in its connect and signing prompts after document.title, read once
// when its script starts in the page, which can be a second or more after load. A tab title
// that leads with the price ("100.957 SOL/USDC · …") then becomes the site's name in the wallet.
// So the tab shows just the brand (index.html sets it before any script) until Backpack is in
// the page, or until it plainly isn't installed, and only then gets the page's own title.
const HOLD_AFTER_LOAD_MS = 4000;

let wanted = null;
let held = true;
let connecting = false;

const apply = () => { document.title = held || connecting || !wanted ? BRAND : wanted; };

function release() {
  if (!held) return;
  held = false;
  apply();
}

if (window.backpack) release();
else {
  const poll = setInterval(() => { if (window.backpack) { clearInterval(poll); release(); } }, 100);
  const giveUp = () => setTimeout(() => { clearInterval(poll); release(); }, HOLD_AFTER_LOAD_MS);
  if (document.readyState === 'complete') giveUp();
  else window.addEventListener('load', giveUp, { once: true });
}

/** Sets the tab title (shown once wallets have read the site name). */
export function setPageTitle(title) {
  wanted = title;
  apply();
}

/** Keeps the tab title to the brand while a wallet connects, for wallets that read it then. */
export function useBrandTitleWhileConnecting() {
  const { connecting: now } = useWallet();
  useEffect(() => {
    connecting = now;
    apply();
  }, [now]);
}
