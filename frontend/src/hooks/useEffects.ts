import { useEffect, useState } from 'react';

export function useEffects() {
  const [enabled, setEnabled] = useState(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    try {
      const saved = localStorage.getItem('maid-effects');
      if (saved === 'on' || saved === 'off') return saved === 'on';
    } catch { /* Preference storage is optional. */ }
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {
      if (media.matches) { setEnabled(false); return; }
      try { setEnabled(localStorage.getItem('maid-effects') !== 'off'); } catch { setEnabled(true); }
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  function toggle() {
    setEnabled(previous => {
      const next = !previous;
      try { localStorage.setItem('maid-effects', next ? 'on' : 'off'); } catch { /* In-memory preference still works. */ }
      return next;
    });
  }
  return { enabled, toggle };
}
