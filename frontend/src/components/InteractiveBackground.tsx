import { useEffect, useRef } from 'react';

type Star = { x: number; y: number; radius: number; vx: number; vy: number; phase: number };
type Ripple = { x: number; y: number; life: number };

/** Original star-island scene; listens only to its containing scene, never to app-wide pointers. */
export function InteractiveBackground({ enabled, className = '', fixedViewport = false }: { enabled: boolean; className?: string; fixedViewport?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !host || !ctx) return;

    let width = 1, height = 1, frame = 0, last = 0, time = 0;
    let visible = true, disposed = false;
    let blue = '#147bc8', coral = '#f39688', dark = false;
    const pointer = { x: 0, y: 0, active: false };
    const ripples: Ripple[] = [];
    // A seeded distribution is stable across StrictMode's setup / cleanup / setup cycle.
    let seed = 4271;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const stars: Star[] = Array.from({ length: 190 }, () => ({
      x: random(), y: random(), radius: 1 + random() * 2.1,
      vx: 4 + random() * 3, vy: -(2 + random() * 3), phase: random() * Math.PI * 2,
    }));
    let count = 80;

    function readColors() {
      const style = getComputedStyle(host!);
      blue = style.getPropertyValue('--primary').trim() || '#147bc8';
      coral = style.getPropertyValue('--coral').trim() || '#f39688';
      dark = document.documentElement.dataset.theme === 'dark';
    }

    function draw() {
      if (disposed) return;
      const context = ctx!;
      context.clearRect(0, 0, width, height);
      for (let i = 0; i < 4; i++) {
        const x = width * (.14 + i * .24);
        const y = height * (.18 + (i % 2) * .54);
        const radius = Math.min(width, height) * (.24 + i * .025);
        const glow = context.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, i % 2 ? blue : coral);
        glow.addColorStop(1, 'transparent');
        context.globalAlpha = dark ? .22 : .20;
        context.fillStyle = glow;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      const positions: Array<[number, number]> = [];
      for (let i = 0; i < count; i++) {
        const star = stars[i];
        const x = ((star.x * width + time * star.vx + 12) % (width + 24)) - 12;
        const y = (((star.y * height + time * star.vy + 12) % (height + 24) + height + 24) % (height + 24)) - 12;
        const dx = pointer.x - x, dy = pointer.y - y, distance = Math.hypot(dx, dy);
        positions.push([x, y]);
        context.globalAlpha = (dark ? .78 : .67) + Math.sin(time + star.phase) * .09;
        context.fillStyle = i % 4 === 0 ? coral : blue;
        context.beginPath(); context.arc(x, y, star.radius, 0, Math.PI * 2); context.fill();
        if (pointer.active && distance < 160) {
          context.globalAlpha = .42 + (1 - distance / 160) * .5;
          context.strokeStyle = dark ? '#ffc1ac' : '#0868b5'; context.lineWidth = dark ? 1.5 : 1.65;
          context.beginPath(); context.moveTo(x, y); context.lineTo(pointer.x, pointer.y); context.stroke();
        }
      }
      for (let i = 0; i < positions.length - 1; i += 4) {
        const a = positions[i], b = positions[i + 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= 150) continue;
        context.globalAlpha = dark ? .30 : .23;
        context.strokeStyle = coral; context.lineWidth = .8;
        context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
      }
      for (const ripple of ripples) {
        context.globalAlpha = Math.max(0, (1 - ripple.life) * .45);
        context.strokeStyle = blue; context.lineWidth = 1.3;
        context.beginPath(); context.arc(ripple.x, ripple.y, ripple.life * 110, 0, Math.PI * 2); context.stroke();
      }
      context.globalAlpha = 1;
    }

    function resize() {
      const rect = host!.getBoundingClientRect();
      width = Math.max(1, fixedViewport ? window.innerWidth : rect.width);
      height = Math.max(1, fixedViewport ? window.innerHeight : rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      canvas!.width = Math.round(width * dpr); canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      count = Math.min(190, Math.max(80, Math.round(width * height / 8500)));
      canvas!.dataset.particleCount = String(count);
      readColors(); draw();
    }
    function tick(stamp: number) {
      frame = 0;
      if (disposed || !enabled || document.hidden || !visible) return;
      // RAF schedules the next opportunity, but expensive canvas work is capped at 30 fps.
      if (!last || stamp - last >= 1000 / 30) {
        const delta = last ? Math.min((stamp - last) / 1000, .08) : 1 / 30;
        last = stamp; time += delta;
        for (let i = ripples.length - 1; i >= 0; i--) {
          ripples[i].life += delta * .65;
          if (ripples[i].life >= 1) ripples.splice(i, 1);
        }
        draw();
      }
      frame = requestAnimationFrame(tick);
    }
    function sync() {
      cancelAnimationFrame(frame); frame = 0; last = 0;
      const running = enabled && !document.hidden && visible && !disposed;
      canvas!.dataset.running = String(running);
      if (running) frame = requestAnimationFrame(tick);
      else { pointer.active = false; ripples.length = 0; if (!document.hidden && visible) draw(); }
    }
    const excluded = (event: PointerEvent) => event.target instanceof Element &&
      !!event.target.closest('form, button, input, a, select, textarea, [data-background-exclude]');
    function move(event: PointerEvent) {
      if (!enabled || !visible || document.hidden) return;
      if (excluded(event)) { pointer.active = false; return; }
      const rect = fixedViewport ? null : host!.getBoundingClientRect();
      pointer.x = fixedViewport ? event.clientX : event.clientX - rect!.left;
      pointer.y = fixedViewport ? event.clientY : event.clientY - rect!.top; pointer.active = true;
    }
    function down(event: PointerEvent) {
      if (!enabled || excluded(event) || !visible || document.hidden) return;
      move(event);
      ripples.push({ x: pointer.x, y: pointer.y, life: .02 });
      if (ripples.length > 6) ripples.shift();
    }
    function leave() { pointer.active = false; }
    function release(event: PointerEvent) { if (event.pointerType !== 'mouse') leave(); }
    const themeObserver = new MutationObserver(() => { readColors(); if (!document.hidden && visible) draw(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : undefined;
    resizeObserver?.observe(host);
    window.addEventListener('resize', resize);
    const intersectionObserver = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true; sync();
    }) : undefined;
    intersectionObserver?.observe(host);
    // Capture on this component's parent so the canvas itself can remain pointer-events:none.
    host.addEventListener('pointermove', move, { passive: true, capture: true });
    host.addEventListener('pointerdown', down, { passive: true, capture: true });
    host.addEventListener('pointerleave', leave, { passive: true });
    host.addEventListener('pointerup', release, { passive: true, capture: true });
    host.addEventListener('pointercancel', leave, { passive: true });
    document.addEventListener('visibilitychange', sync);
    resize(); sync();
    return () => {
      disposed = true; cancelAnimationFrame(frame); canvas.dataset.running = 'false';
      resizeObserver?.disconnect(); intersectionObserver?.disconnect(); themeObserver.disconnect();
      window.removeEventListener('resize', resize);
      host.removeEventListener('pointermove', move, true); host.removeEventListener('pointerdown', down, true);
      host.removeEventListener('pointerleave', leave); host.removeEventListener('pointerup', release, true);
      host.removeEventListener('pointercancel', leave); document.removeEventListener('visibilitychange', sync);
    };
  }, [enabled, fixedViewport]);

  return <canvas ref={canvasRef} className={`login-starfield ${className}`} data-motion="autonomous" data-effects={enabled ? 'on' : 'off'} aria-hidden="true" style={{ pointerEvents: 'none' }}/>;
}
