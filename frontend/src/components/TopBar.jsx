import { Link, NavLink } from 'react-router-dom';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import './TopBar.css';

export default function TopBar() {
  return (
    <header className="topbar">
      <Link to="/" className="brand">Spot<span>Book</span></Link>
      <nav className="topnav">
        <NavLink to="/" className={({ isActive }) => `topnav-item ${isActive || window.location.pathname.startsWith('/trade') ? 'active' : ''}`} end>Trade</NavLink>
        <NavLink to="/account" className={({ isActive }) => `topnav-item ${isActive ? 'active' : ''}`}>Account</NavLink>
      </nav>
      <div className="topbar-right">
        <WalletMultiButton />
      </div>
    </header>
  );
}
