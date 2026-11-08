import { describe,it,expect,vi,afterEach } from 'vitest';
import { readLimitedBody } from '../src/lib/request-body';
import { rateLimitIp } from '../src/lib/request-ip';
import { canRetryBankEvent,unmatchedBankEventReason } from '../src/lib/payment-event';
import { api } from '../src/components/ui';
vi.mock('@radix-ui/react-dialog',()=>({}));
vi.mock('@phosphor-icons/react',()=>({}));

function streamed(chunks:Uint8Array[],headers?:HeadersInit,cancel=()=>{}){
 let index=0;const stream=new ReadableStream<Uint8Array>({pull(controller){if(index<chunks.length)controller.enqueue(chunks[index++]);else controller.close();},cancel},{highWaterMark:0});
 return new Request('http://localhost',{method:'POST',headers,body:stream,duplex:'half'} as RequestInit);
}
describe('Đọc body có giới hạn',()=>{
 it('đọc body rỗng',async()=>expect(await readLimitedBody(new Request('http://localhost'),5)).toEqual(new Uint8Array(0)));
 it('ghép các chunk và chấp nhận đúng ngưỡng byte',async()=>expect(await readLimitedBody(streamed([new Uint8Array([1,2]),new Uint8Array([3])]),3)).toEqual(new Uint8Array([1,2,3])));
 it('đếm byte UTF-8 thay vì số ký tự',async()=>{const bytes=new TextEncoder().encode('Quán');await expect(readLimitedBody(streamed([bytes]),4)).rejects.toMatchObject({status:413});});
 it.each([undefined,{'Content-Length':'1'},{'Content-Length':'invalid'}])('không tin Content-Length: %j',async headers=>{await expect(readLimitedBody(streamed([new Uint8Array(3),new Uint8Array(3)],headers),5)).rejects.toMatchObject({status:413});});
 it('đọc theo byte thực tế dù header khai lớn',async()=>expect((await readLimitedBody(streamed([new Uint8Array(2)],{'Content-Length':'9999'}),2)).length).toBe(2));
 it('hủy stream ngay khi vượt ngưỡng, không đợi nguồn đóng',async()=>{
  let pulls=0;const cancel=vi.fn(()=>new Promise<void>(()=>{}));const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(4));},cancel},{highWaterMark:0});
  const request=new Request('http://localhost',{method:'POST',body:stream,duplex:'half'} as RequestInit);
  await expect(readLimitedBody(request,5)).rejects.toMatchObject({status:413});expect(pulls).toBe(2);expect(cancel).toHaveBeenCalledOnce();expect(stream.locked).toBe(false);
 });
});
describe('IP cho rate limit',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('mặc định tin IP cuối từ proxy khi không đặt TRUST_PROXY',()=>{vi.stubEnv('TRUST_PROXY',undefined);expect(rateLimitIp(new Headers({'X-Forwarded-For':'spoofed, 192.0.2.9, 198.51.100.5 '}))).toBe('198.51.100.5');});
 it('bỏ qua header khi TRUST_PROXY=0',()=>{vi.stubEnv('TRUST_PROXY','0');expect(rateLimitIp(new Headers({'X-Forwarded-For':'1.2.3.4'}))).toBe('unknown');});
 it.each(['1','true','yes',''])('tin proxy khi TRUST_PROXY khác 0: %s',value=>{vi.stubEnv('TRUST_PROXY',value);expect(rateLimitIp(new Headers({'X-Forwarded-For':'1.2.3.4'}))).toBe('1.2.3.4');});
 it('lấy phần tử cuối khi tin proxy',()=>expect(rateLimitIp(new Headers({'X-Forwarded-For':'spoofed, 192.0.2.9, 198.51.100.5 '}),'1')).toBe('198.51.100.5'));
 it('hỗ trợ IPv6',()=>expect(rateLimitIp(new Headers({'X-Forwarded-For':'2001:db8::1'}),'1')).toBe('2001:db8::1'));
 it.each([null,'','invalid','192.0.2.9,','192.0.2.9,invalid'])('dùng khóa chung nếu IP thiếu/sai: %s',value=>{vi.stubEnv('TRUST_PROXY',undefined);const headers=new Headers(value===null?{}:{'X-Forwarded-For':value});expect(rateLimitIp(headers)).toBe('unknown');expect(rateLimitIp(headers,'1')).toBe('unknown');});
});
describe('Ghép lại webhook',()=>{
 const unmatched={state:'REVIEW',reason:unmatchedBankEventReason,resolvedAt:null};
 it('chỉ thử lại sự kiện chưa tìm thấy attempt',()=>expect(canRetryBankEvent(unmatched)).toBe(true));
 it.each(['APPLIED','RESOLVED'])('không thử lại trạng thái %s',state=>expect(canRetryBankEvent({...unmatched,state})).toBe(false));
 it.each(['Số tiền không khớp đơn.','Giao dịch phát sinh sau khi yêu cầu đã hết hạn.',null])('không thử lại lý do khác: %s',reason=>expect(canRetryBankEvent({...unmatched,reason})).toBe(false));
 it('không thử lại sự kiện đã xử lý thủ công',()=>expect(canRetryBankEvent({...unmatched,resolvedAt:new Date()})).toBe(false));
});
describe('Timeout API client',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 function waitingFetch(){vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>{const signal=init.signal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})));}
 it('báo lỗi tiếng Việt khi quá hạn',async()=>{waitingFetch();await expect(api('/test',{timeoutMs:5})).rejects.toThrow('Yêu cầu đã hết thời gian chờ. Vui lòng thử lại.');});
 it('giữ tín hiệu hủy do caller truyền vào',async()=>{waitingFetch();const controller=new AbortController();const pending=api('/test',{signal:controller.signal});controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});});
});
