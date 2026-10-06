import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';
import App from './App.jsx';
import { ToastProvider } from './components/Toasts.jsx';
import { installGlobalErrorReporting } from './services/report';

installGlobalErrorReporting();

// Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack, ...) are detected
// automatically, so no adapters are listed here.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </WalletModalProvider>
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
