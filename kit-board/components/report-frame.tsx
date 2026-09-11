'use client';
import { useEffect, useRef, useState } from 'react';

export function ReportFrame({ id, title }: { id: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(800);
  useEffect(() => {
    let pending = 0;
    const viewport = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const element = frame.current;
        if (!element) return;
        const header = document.querySelector('[data-app-header]')?.getBoundingClientRect().bottom ?? 0;
        element.contentWindow?.postMessage({ type: 'observatory:viewport', top: Math.max(0, header - element.getBoundingClientRect().top), height: window.innerHeight - header }, '*');
      });
    };
    const receive = (event: MessageEvent) => {
      // The report has an opaque origin: identity is its WindowProxy, not origin.
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'observatory:height' && Number.isFinite(data.height) && data.height > 0 && data.height <= 2_000_000) {
        setHeight(Math.ceil(data.height));
        viewport();
      }
      if (data.type === 'observatory:scroll' && Number.isFinite(data.top) && data.top >= 0 && data.top <= 2_000_000) {
        const element = frame.current;
        if (!element) return;
        const header = document.querySelector('[data-app-header]')?.getBoundingClientRect().bottom ?? 0;
        window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top + data.top - header, behavior: 'instant' });
      }
    };
    window.addEventListener('message', receive);
    window.addEventListener('scroll', viewport, { passive: true });
    window.addEventListener('resize', viewport);
    const element = frame.current;
    element?.addEventListener('load', viewport);
    viewport();
    return () => {
      cancelAnimationFrame(pending);
      window.removeEventListener('message', receive);
      window.removeEventListener('scroll', viewport);
      window.removeEventListener('resize', viewport);
      element?.removeEventListener('load', viewport);
    };
  }, [id]);
  return <iframe ref={frame} title={title} className="report-frame" style={{ height }} src={`/api/artifacts/${id}`} sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals" referrerPolicy="no-referrer"/>;
}
