"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { RealtimeConnection } from '@/lib/voice/RealtimeConnection';
import { Caption, PlatformReply, VoiceStatus, describeVoiceError } from '@/lib/voice/protocol';

interface Props {
  minimized?: boolean;
  copilotName?: string;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  context: {role: string; text: string}[];
  onPlatformRequest: (request: string, heardDirectly: boolean) => Promise<PlatformReply | undefined>;
}

export default function VoiceOverlay({onClose, context, onPlatformRequest, minimized = false, onMinimize, onRestore, copilotName = 'GetInsuredAI'}: Props) {
  const {locale} = useI18n();
  const [spokenLanguage, setSpokenLanguage] = useState<'en' | 'ur'>(locale);
  const ur = spokenLanguage === 'ur';
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
      onLanguage: value => {if (mounted) setSpokenLanguage(value);},
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
  const control = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:opacity-40';

  if (minimized) return <div className="rounded-2xl bg-slate-950 text-white shadow-xl border border-indigo-400/30 p-3 flex flex-wrap items-center gap-2" role="region" aria-label={text('Active voice call', 'فعال وائس کال')}>
    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"/><span className="text-xs max-w-[150px]">{label}</span>
    <button className={control} onClick={onRestore}>{text('Open voice', 'وائس کھولیں')}</button>
    <button className={control} aria-pressed={muted} disabled={!connected} onClick={() => {connection.current?.mute(!muted); setMuted(!muted);}}>{muted ? text('Unmute', 'مائیک کھولیں') : text('Mute', 'مائیک بند کریں')}</button>
    <button className={`${control} bg-rose-600`} onClick={finish}>{text('End call', 'کال ختم کریں')}</button>
  </div>;

  return <div ref={dialog} role="dialog" aria-modal="true" aria-label={text('Live voice', 'لائیو وائس')} className="absolute inset-0 z-50 flex min-h-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950 text-white shadow-2xl" dir={ur ? 'rtl' : 'ltr'}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-slate-900/70 px-5 py-4 sm:px-6">
      <div className="min-w-0"><div className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`} /><h2 className="truncate font-semibold">{copilotName}</h2><span className="rounded-md bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200">{text('Live voice', 'لائیو وائس')}</span></div>
        <p className="mt-1 text-xs text-slate-400">{text('AI-generated voice', 'اے آئی کی تیار کردہ آواز')} <span aria-hidden="true">·</span> <span className="tabular-nums" dir="ltr">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span></p></div>
      <button className={`${control} !h-10 !min-h-10 !w-10 !rounded-full !p-0`} onClick={finish} aria-label={text('Close voice call', 'وائس کال بند کریں')}><svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    <div className="relative flex shrink-0 flex-col items-center gap-3 bg-gradient-to-b from-indigo-950/40 to-transparent px-5 py-5 sm:py-7">
      <div className={`flex h-20 w-20 items-center justify-center rounded-3xl border shadow-[0_0_45px_rgba(56,189,248,.12)] ${muted ? 'border-slate-600 bg-slate-800 text-slate-400' : 'border-sky-300/25 bg-gradient-to-br from-indigo-500/50 to-sky-500/30 text-sky-100'}`}>
        <svg aria-hidden="true" className="h-9 w-9" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.6"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{muted && <path d="m3 3 18 18"/>}</svg>
      </div>
      <div className="flex h-5 items-center gap-1" aria-hidden="true">{[8,14,20,12,24,16,20,12,8].map((height,i)=><span key={i} className={`w-1 rounded-full ${muted || !connected ? 'bg-slate-600' : 'bg-sky-300'} ${status === 'speaking' && !muted ? 'animate-pulse motion-reduce:animate-none' : ''}`} style={{height: muted ? 4 : height, animationDelay:`${i*90}ms`}} />)}</div>
      <p role="status" className="text-center text-sm font-medium text-sky-100">{label}</p>
      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-slate-300">{text('Auto language · English / اردو', 'خودکار زبان · اردو / English')}</span>
      {error && <p role="alert" className="max-w-md rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-center text-sm text-rose-200">{error}</p>}
      {status === 'error' && <button className={control} onClick={() => setAttempt(a => a + 1)}>{text('Retry connection', 'دوبارہ کنکشن کریں')}</button>}
      {playbackBlocked && connected && <button className={control} onClick={() => {setPlaybackBlocked(false); void connection.current?.resumePlayback();}}>{text('Tap to enable audio', 'آواز سننے کے لیے دبائیں')}</button>}
    </div>
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 sm:px-6">
      <div className="mb-3 flex items-center justify-between text-[11px] font-semibold text-slate-400"><span>{text('Conversation', 'گفتگو')}</span><span>{text('Live captions', 'لائیو کیپشنز')}</span></div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-slate-900/40 p-3 sm:p-4" aria-label={text('Live captions', 'لائیو کیپشنز')}>
        {!captions.length && <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-4 text-center"><p className="text-sm font-medium text-slate-200">{text('Your conversation starts here', 'آپ کی گفتگو یہاں شروع ہوتی ہے')}</p><p className="max-w-sm text-xs leading-relaxed text-slate-400">{text('Speak in Urdu or English. Replies follow your language automatically. You can interrupt at any time.', 'اردو یا انگریزی میں بات کریں۔ جواب خود بخود آپ کی زبان میں ملے گا۔ آپ کسی بھی وقت بات کر سکتے ہیں۔')}</p></div>}
        {captions.map(c => <div key={c.id} className={`flex ${c.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[95%] rounded-2xl border px-4 py-3 sm:max-w-[88%] ${c.role === 'user' ? 'border-indigo-400/20 bg-indigo-500/15' : 'border-white/10 bg-slate-800/80'}`}><span className={`mb-1.5 block text-[11px] font-semibold ${c.role === 'user' ? 'text-indigo-200' : 'text-sky-200'}`}>{c.role === 'user' ? text('You', 'آپ') : copilotName}</span><p dir="auto" className={`whitespace-pre-wrap break-words text-sm text-slate-100 ${/[\u0600-\u06ff]/.test(c.text) ? 'text-right leading-[2]' : 'leading-relaxed'}`}>{c.text}</p></div></div>)}
        <div ref={end}/>
      </div>
    </div>
    <footer className="flex shrink-0 flex-col items-center gap-3 border-t border-white/10 bg-slate-900/70 px-4 pb-5 pt-4">
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:justify-center">
        <button disabled={!connected} className={control} aria-pressed={muted} onClick={() => {connection.current?.mute(!muted); setMuted(!muted);}}>{muted ? text('Unmute', 'مائیک کھولیں') : text('Mute microphone', 'مائیک بند کریں')}</button>
        <button disabled={!connected || status !== 'speaking'} className={control} onClick={() => connection.current?.interrupt()}>{text('Stop speaking', 'بولنا روکیں')}</button>
        <button className={control} onClick={onMinimize}>{text('Show chat', 'چیٹ دکھائیں')}</button>
        <button className={`${control} !border-rose-500/40 !bg-rose-600 hover:!bg-rose-500`} onClick={finish}><svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 15v-3c4-4 12-4 16 0v3l-4 1-1-3H9l-1 3-4-1Z" /></svg>{text('End call', 'کال ختم کریں')}</button>
      </div>
      <p className="text-center text-[11px] text-slate-400">{text('Actions and confirmations also appear in your chat.', 'کارروائیاں اور تصدیقیں آپ کی چیٹ میں بھی دکھائی دیتی ہیں۔')}</p>
    </footer>
  </div>;
}
