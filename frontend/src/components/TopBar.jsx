import { Link, NavLink } from 'react-router-dom';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { BRAND } from '../brand';
import './TopBar.css';

export default function TopBar() {
  return (
    <header className="topbar">
      <Link to="/" className="brand">{BRAND.replace(/Terminal$/, "")}<span>Terminal</span></Link>
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
