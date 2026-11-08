'use client';
import { createContext,useContext,useEffect,useState,useRef,useCallback,type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X,WarningCircle,CheckCircle,CircleNotch } from '@phosphor-icons/react';
export async function api<T=unknown>(url:string,options:RequestInit&{timeoutMs?:number}={}):Promise<T>{
 const {timeoutMs=20000,...init}=options;const timeout=AbortSignal.timeout(timeoutMs);const signal=AbortSignal.any([timeout,...(init.signal?[init.signal]:[])]);
 try{const response=await fetch(url,{...init,signal,headers:{...(init.body&&typeof init.body==='string'?{'Content-Type':'application/json'}:{}),...init.headers},cache:'no-store'});let data;try{data=await response.json();}catch{if(signal.aborted)throw signal.reason;throw new Error('Máy chủ chưa phản hồi. Vui lòng thử lại.');}if(!response.ok)throw new Error(data.error??data.message??'Không thể xử lý yêu cầu.');return data;}catch(e){if(timeout.aborted&&signal.reason===timeout.reason)throw new Error('Yêu cầu đã hết thời gian chờ. Vui lòng thử lại.');throw e;}
}
export const post=<T=unknown,>(url:string,data:unknown)=>api<T>(url,{method:'POST',body:JSON.stringify(data)});
export function useRemote<T>(url:string,interval=0,stopWhen?:(value:T)=>boolean){
 const [data,setData]=useState<T|null>(null);const dataRef=useRef<{url:string;value:T|null}>({url,value:null});const stopRef=useRef(stopWhen);stopRef.current=stopWhen;
 const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [revision,setRevision]=useState(0);const reload=useCallback(()=>setRevision(v=>v+1),[]);
 useEffect(()=>{
  let alive=true;let running=false;let timer:ReturnType<typeof setTimeout>|undefined;const abort=new AbortController();
  if(dataRef.current.url!==url){dataRef.current={url,value:null};setData(null);setError('');setLoading(true);}
  const stopped=()=>dataRef.current.value!==null&&stopRef.current?.(dataRef.current.value);
  async function run(force=false){
   if(!alive||running||(!force&&stopped())||(document.hidden&&dataRef.current.value!==null))return;
   clearTimeout(timer);running=true;
   try{const next=await api<T>(url,{signal:abort.signal});if(alive){dataRef.current={url,value:next};setData(next);setError('');}}
   catch(e){if(alive&&!abort.signal.aborted)setError(e instanceof Error?e.message:'Mất kết nối.');}
   finally{running=false;if(alive){setLoading(false);if(interval&&!document.hidden&&!stopped())timer=setTimeout(run,interval);}}
  }
  function visibility(){clearTimeout(timer);if(!document.hidden)void run();}
  document.addEventListener('visibilitychange',visibility);void run(true);
  return()=>{alive=false;abort.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
 },[url,interval,revision]);return {data,error,loading,reload};
}
const ToastContext=createContext<(message:string,error?:boolean)=>void>(()=>{});
export function Providers({children}:{children:ReactNode}){const [toast,setToast]=useState<{message:string;error:boolean}|null>(null);const notify=useCallback((message:string,error=false)=>setToast({message,error}),[]);useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),5500);return()=>clearTimeout(timer);},[toast]);return <ToastContext.Provider value={notify}>{children}{toast&&<div className={'toast '+(toast.error?'error':'')} role={toast.error?'alert':'status'}>{toast.error?<WarningCircle size={22}/>:<CheckCircle size={22}/>}<span>{toast.message}</span><button className="icon-btn" aria-label="Đóng thông báo" onClick={()=>setToast(null)}><X/></button></div>}</ToastContext.Provider>;}
export function useTask(){const notify=useContext(ToastContext);const [busy,setBusy]=useState(false);async function run<T>(action:()=>Promise<T>,success?:string){if(busy)return;setBusy(true);try{const result=await action();if(success)notify(success);return result;}catch(e){notify(e instanceof Error?e.message:'Đã xảy ra lỗi.',true);}finally{setBusy(false);}}return {busy,run,notify};}
export function Modal({open,onClose,title,description,children,wide=false}:{open:boolean;onClose:()=>void;title:string;description?:string;children:ReactNode;wide?:boolean}){return <Dialog.Root open={open} onOpenChange={value=>!value&&onClose()}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className={'dialog '+(wide?'wide':'')}><div className="dialog-head"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description className={description?'muted':'sr-only'}>{description??title}</Dialog.Description></div><Dialog.Close asChild><button className="icon-btn" aria-label="Đóng"><X size={22}/></button></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;}
export function ErrorState({message,retry}:{message:string;retry?:()=>void}){return <div className="error-box" role="alert"><WarningCircle size={20}/><span>{message}</span>{retry&&<button className="btn small ghost" onClick={retry}>Thử lại</button>}</div>;}
export function Loading(){return <div className="empty"><CircleNotch size={30} className="spin"/><p>Đang tải dữ liệu…</p></div>;}
export function Empty({title,description,children}:{title:string;description?:string;children?:ReactNode}){return <div className="empty"><div className="empty-icon"><CheckCircle size={30}/></div><h3>{title}</h3>{description&&<p>{description}</p>}{children}</div>;}
export function Badge({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={'badge '+tone}>{children}</span>;}
export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;}
export function PageHead({eyebrow,title,description,children}:{eyebrow?:string;title:string;description?:string;children?:ReactNode}){return <header className="page-head"><div>{eyebrow&&<div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description&&<p>{description}</p>}</div>{children&&<div className="head-actions">{children}</div>}</header>;}
