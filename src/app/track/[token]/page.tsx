import { TrackingScreen } from '@/components/tracking-screen';
export default async function Tracking({params}:{params:Promise<{token:string}>}){return <TrackingScreen token={(await params).token}/>;}
