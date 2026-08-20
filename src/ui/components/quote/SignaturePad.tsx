// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { Eraser } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Draw-to-sign.
 *
 * A typed name is what makes an e-signature binding, but a drawn mark is what
 * makes a homeowner feel the weight of what they are doing. Tapping "Accept"
 * is a click; signing is a decision. Both are captured.
 */

interface Props {
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}

export function SignaturePad({ onChange, disabled }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  // Size the backing store to the device pixel ratio, or the line looks furry
  // on the phones this will mostly be signed on.
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  useEffect(() => {
    resize();
    // Resizing the canvas wipes the drawn strokes, so the captured mark has to
    // go with them. But the mobile keyboard opening fires resize with the SAME
    // pad width — wiping a finished signature because someone tapped the name
    // field is unforgivable, so only a genuine width change clears.
    let lastWidth = canvasRef.current?.getBoundingClientRect().width ?? 0;
    const onResize = () => {
      const width = canvasRef.current?.getBoundingClientRect().width ?? lastWidth;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      resize();
      setHasInk(false);
      onChange(null);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [resize, onChange]);

  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pointFrom(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawing.current = true;
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    // Stops the page scrolling under the finger mid-signature.
    event.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pointFrom(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasInk) setHasInk(true);
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (canvas && hasInk) onChange(canvas.toDataURL('image/png'));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border-2 border-dashed border-border-strong bg-white">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          className="h-36 w-full touch-none"
          style={{ cursor: disabled ? 'not-allowed' : 'crosshair' }}
        />
        {!hasInk ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-gray-400">
            Sign here
          </p>
        ) : null}
        {/* The signing line, so the box reads as a signature field. */}
        <span className="pointer-events-none absolute inset-x-6 bottom-7 border-gray-300 border-b" />
      </div>

      {hasInk ? (
        <button
          type="button"
          onClick={clear}
          className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-800"
        >
          <Eraser size={12} strokeWidth={2} />
          Clear and sign again
        </button>
      ) : null}
    </div>
  );
}
