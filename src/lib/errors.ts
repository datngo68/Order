export class AppError extends Error {
  constructor(public status:number,message:string) { super(message); }
}
export function ensure(condition:unknown,message:string,status=400): asserts condition { if(!condition) throw new AppError(status,message); }
