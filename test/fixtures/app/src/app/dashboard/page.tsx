import { deletePost } from '../actions'
import { BaseUrlUser } from 'src/components/BaseUrlUser'
import { ClientStats } from '@/components/ClientStats'
export const dynamic = 'force-dynamic'
export default function Dashboard() { return <form action={deletePost}><BaseUrlUser /><ClientStats /><button>Delete</button></form> }
