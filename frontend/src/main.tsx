import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import { AuthGate } from './AuthGate';

try { document.documentElement.dataset.theme = localStorage.getItem('maid-theme') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.dataset.theme = 'light'; }
const root = document.getElementById('root');
if (!root) throw new Error('页面缺少 React 挂载点');
createRoot(root).render(<StrictMode><AuthGate/></StrictMode>);
