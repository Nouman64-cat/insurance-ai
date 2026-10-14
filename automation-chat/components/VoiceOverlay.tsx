"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { RealtimeConnection } from '@/lib/voice/RealtimeConnection';
import { Caption, PlatformReply, VoiceStatus, describeVoiceError } from '@/lib/voice/protocol';

interface Props {
  minimized?: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  context: {role: string; text: string}[];
  onPlatformRequest: (request: string, heardDirectly: boolean) => Promise<PlatformReply | undefined>;
}

export default function VoiceOverlay({onClose, context, onPlatformRequest, minimized = false, onMinimize, onRestore}: Props) {
  const {locale} = useI18n();
  const ur = locale === 'ur';
  const [status, setStatus] = useState<VoiceStatus>('connecting');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const connection = useRef<RealtimeConnection | null>(null);
  const invoke = useRef(onPlatformRequest); invoke.current = onPlatformRequest;
  const minimize = useRef(onMinimize); minimize.current = onMinimize;
  const contextRef = useRef(context); contextRef.current = context;
  const end = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const text = (en: string, translated: string) => ur ? translated : en;

  useEffect(() => {
    let mounted = true;
    setStatus('connecting'); setError(''); setMuted(false); setPlaybackBlocked(false); setElapsed(0);
    const call = new RealtimeConnection({locale, context: contextRef.current,
      onStatus: value => {if (mounted) setStatus(value);},
      onError: value => {if (mounted) setError(value);},
      onPlaybackBlocked: () => {if (mounted) setPlaybackBlocked(true);},
      onCaption: caption => {if (mounted) setCaptions(previous => {
        const index = previous.findIndex(c => c.id === caption.id);
        if (index === -1) return [...previous, caption].slice(-100);
        return previous.map((c, i) => i === index ? caption : c);
      });},
      onPlatformRequest: async (request, heardDirectly) => {
        const result = await invoke.current(request, heardDirectly);
        if (mounted && result?.pending === 'client_execute') minimize.current();
        return result;
      },
    });
    connection.current = call;
    void call.start().catch(e => {if (mounted) {setError(describeVoiceError(e)); setStatus('error'); call.close();}});
    return () => {mounted = false; call.close(); if (connection.current === call) connection.current = null;};
  }, [attempt, locale]);

  const connected = status !== 'connecting' && status !== 'error';
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(timer);
  }, [connected]);
  useEffect(() => {
    if (elapsed >= 15 * 60) {connection.current?.close(); setStatus('error'); setError(text('This 15-minute call has ended. Retry to start a new call; your chat is saved.', 'یہ پندرہ منٹ کی کال ختم ہو گئی ہے۔ نئی کال کے لیے دوبارہ کوشش کریں۔'));}
  }, [elapsed, ur]);
  useEffect(() => {end.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});}, [captions]);
  useEffect(() => {
    if (minimized) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {connection.current?.close(); closeRef.current();}
      if (e.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {e.preventDefault(); last?.focus();}
        if (!e.shiftKey && document.activeElement === last) {e.preventDefault(); first?.focus();}
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {document.removeEventListener('keydown', keydown); previous?.focus();};
  }, [minimized]);
  const finish = () => {connection.current?.close(); onClose();};
  const label = status === 'error' ? text('Connection paused', 'کنکشن رک گیا ہے')
    : status === 'connecting' ? text('Connecting…', 'کنکشن قائم ہو رہا ہے…')
    : muted ? text('Microphone muted', 'مائیکروفون بند ہے')
    : status === 'speaking' ? text('Speaking · you can interrupt', 'بول رہا ہوں · آپ بات کر سکتے ہیں')
    : status === 'thinking' ? text('Working on your request…', 'آپ کی درخواست پر کام ہو رہا ہے…')
    : text('Listening · go ahead', 'سن رہا ہوں · بات کیجیے');
  const control = 'rounded-full border border-white/20 px-4 py-2 text-sm transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40';

  if (minimized) return <div className="rounded-2xl bg-slate-950 text-white shadow-xl border border-indigo-400/30 p-3 flex flex-wrap items-center gap-2" role="region" aria-label={text('Active voice call', 'فعال وائس کال')}>
    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"/><span className="text-xs max-w-[150px]">{label}</span>
    <button className={control} onClick={onRestore}>{text('Open voice', 'وائس کھولیں')}</button>
    <button className={control} aria-pressed={muted} disabled={!connected} onClick={() => {connection.current?.mute(!muted); setMuted(!muted);}}>{muted ? text('Unmute', 'مائیک کھولیں') : text('Mute', 'مائیک بند کریں')}</button>
    <button className={`${control} bg-rose-600`} onClick={finish}>{text('End call', 'کال ختم کریں')}</button>
  </div>;

  return <div ref={dialog} role="dialog" aria-modal="true" aria-label={text('Live voice', 'لائیو وائس')} className="absolute inset-0 z-50 flex flex-col rounded-[1.75rem] overflow-hidden bg-slate-950 text-white" dir={ur ? 'rtl' : 'ltr'}>
    <header className="flex items-center justify-between px-5 pt-5">
      <div><h2 className="font-semibold">{text('Insurance AI · Live voice', 'انشورنس اے آئی · لائیو وائس')}</h2><p className="text-xs text-slate-400">{text('AI-generated voice', 'اے آئی کی تیار کردہ آواز')} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</p></div>
      <button className={control} onClick={finish} aria-label={text('Close voice call', 'وائس کال بند کریں')}>×</button>
    </header>
    <div className="flex flex-col items-center gap-4 py-6 px-5">
      <div className={`w-28 h-28 rounded-full flex items-center justify-center border border-indigo-300/30 bg-gradient-to-br from-indigo-500 to-sky-700 shadow-[0_0_55px_rgba(99,102,241,.35)] ${status === 'speaking' ? 'animate-pulse' : ''}`}>
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{muted && <path d="m3 3 18 18"/>}</svg>
      </div>
      <p role="status" className="text-sm text-indigo-100">{label}</p>
      {error && <p role="alert" className="text-sm text-rose-200 text-center max-w-md">{error}</p>}
      {status === 'error' && <button className={control} onClick={() => setAttempt(a => a + 1)}>{text('Retry connection', 'دوبارہ کنکشن کریں')}</button>}
      {playbackBlocked && connected && <button className={control} onClick={() => {setPlaybackBlocked(false); void connection.current?.resumePlayback();}}>{text('Tap to enable audio', 'آواز سننے کے لیے دبائیں')}</button>}
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto px-4 space-y-3 pb-4" aria-label={text('Live captions', 'لائیو کیپشنز')}>
      {!captions.length && <p className="text-center text-sm text-slate-400 py-6">{text('Speak naturally. English and Urdu are welcome.', 'قدرتی انداز میں بات کریں۔ انگریزی اور اردو دونوں بول سکتے ہیں۔')}</p>}
      {captions.map(c => <div key={c.id} className={`flex ${c.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${c.role === 'user' ? 'bg-indigo-500/25' : 'bg-white/10'}`}><span className="block text-[10px] text-slate-300 mb-1">{c.role === 'user' ? text('You', 'آپ') : 'Insurance AI'}</span><p dir="auto">{c.text}</p></div></div>)}
      <div ref={end}/>
    </div>
    <footer className="px-4 pb-5 pt-3 border-t border-white/10 flex flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-2">
        <button disabled={!connected} className={control} aria-pressed={muted} onClick={() => {connection.current?.mute(!muted); setMuted(!muted);}}>{muted ? text('Unmute', 'مائیک کھولیں') : text('Mute', 'مائیک بند کریں')}</button>
        <button disabled={!connected} className={control} onClick={() => connection.current?.interrupt()}>{text('Stop speaking', 'بولنا روکیں')}</button>
        <button className={control} onClick={onMinimize}>{text('Show chat', 'چیٹ دکھائیں')}</button>
        <button className={`${control} bg-rose-600 hover:bg-rose-500`} onClick={finish}>{text('End call', 'کال ختم کریں')}</button>
      </div>
      <p className="text-[11px] text-slate-400 text-center">{text('Actions and confirmations also appear in your chat.', 'کارروائیاں اور تصدیقیں آپ کی چیٹ میں بھی دکھائی دیتی ہیں۔')}</p>
    </footer>
  </div>;
}
