'use client';

import { useEffect, useRef } from 'react';
import { createNoise3D } from 'simplex-noise';
import { useReducedMotion } from '@/lib/use-reduced-motion';

interface WavyBackgroundProps {
  colors?: string[];
  waveWidth?: number;
  blur?: number;
  speed?: 'slow' | 'fast';
  opacity?: number;
  className?: string;
}

// Module-level so the default keeps one identity and never re-runs the effect.
const DEFAULT_COLORS = ['#5e6ad2', '#7170ff', '#8a92ff', '#4c57b8', '#5e6ad2'];

export function WavyBackground({
  colors = DEFAULT_COLORS,
  waveWidth = 50,
  blur = 10,
  speed = 'slow',
  opacity = 0.35,
  className,
}: WavyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const noise = createNoise3D();
    const step = speed === 'fast' ? 0.002 : 0.001;
    let nt = 0;
    let w = 0;
    let h = 0;
    let animationId = 0;
    // Off-screen, the loop has nothing to show; stop it instead of burning frames.
    let visible = true;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
      ctx.filter = `blur(${blur}px)`;
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = opacity;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.lineWidth = waveWidth;
        ctx.strokeStyle = colors[i % colors.length];
        for (let x = 0; x < w; x += 5) {
          const y = noise(x / 800, 0.3 * i, nt) * 100;
          ctx.lineTo(x, y + h * 0.5);
        }
        ctx.stroke();
        ctx.closePath();
      }
    };

    const loop = () => {
      nt += step;
      draw();
      animationId = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(animationId);
      // Reduced motion gets one still frame, never a running loop.
      if (reducedMotion || !visible) draw();
      else loop();
    };

    resize();
    start();

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else cancelAnimationFrame(animationId);
    });
    observer.observe(canvas);

    const handleResize = () => {
      resize();
      if (reducedMotion) draw();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [blur, colors, opacity, speed, waveWidth, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{ display: 'block' }}
    />
  );
}
