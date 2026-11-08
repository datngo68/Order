export const unmatchedBankEventReason='Không tìm thấy yêu cầu thanh toán tương ứng.';
export function canRetryBankEvent(event:{state:string;reason:string|null;resolvedAt:Date|null}){
 return event.state==='REVIEW'&&event.reason===unmatchedBankEventReason&&!event.resolvedAt;
}
