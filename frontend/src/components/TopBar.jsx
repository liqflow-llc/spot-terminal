import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import './TopBar.css';

export default function TopBar() {
  return (
    <header className="topbar">
      <a href="/" className="brand">Spot<span>Book</span></a>
      <nav className="topnav">
        <span className="topnav-item active">Trade</span>
      </nav>
      <div className="topbar-right">
        <WalletMultiButton />
      </div>
    </header>
  );
}
