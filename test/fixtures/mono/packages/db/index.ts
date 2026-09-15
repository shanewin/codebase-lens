import { Pool } from 'pg'
const pool = new Pool()
export async function getUsers() { return pool.query('select 1') }
