'use client';

import { useEffect, useRef } from 'react';
import { createNoise3D } from 'simplex-noise';

interface WavyBackgroundProps {
  colors?: string[];
  waveWidth?: number;
  blur?: number;
  speed?: 'slow' | 'fast';
  opacity?: number;
  className?: string;
}

export function WavyBackground({
  colors = ['#5e6ad2', '#7170ff', '#8a92ff', '#4c57b8', '#5e6ad2'],
  waveWidth = 50,
  blur = 10,
  speed = 'slow',
  opacity = 0.35,
  className,
}: WavyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const noise = createNoise3D();
    const getSpeed = () => (speed === 'fast' ? 0.002 : 0.001);
    let nt = 0;
    let w = 0;
    let h = 0;
    let animationId = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
      ctx.filter = `blur(${blur}px)`;
    };

    const drawWave = (n: number) => {
      nt += getSpeed();
      for (let i = 0; i < n; i++) {
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

    const render = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = opacity;
      drawWave(5);
      animationId = requestAnimationFrame(render);
    };

    resize();
    render();

    const handleResize = () => resize();
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', handleResize);
    };
  }, [blur, colors, opacity, speed, waveWidth]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block' }}
    />
  );
}
