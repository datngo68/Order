'use client';
import Link from 'next/link';
import { Bell } from '@phosphor-icons/react';
import { useRemote } from './ui';
export function TableAlert() {
  const {data}=useRemote<{pending:number}>('/api/table-alerts',5000);
  return data?.pending?<Link href="/tables" className="table-alert" role="status"><Bell size={19}/><strong>{data.pending} bàn đang gọi thanh toán</strong><span>Tiếp nhận yêu cầu →</span></Link>:null;
}
