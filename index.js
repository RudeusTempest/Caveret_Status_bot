import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

async function test() {
  const { data: insertData, error: insertError } = await supabase
    .from('reports')
    .insert([
      {
        store_id: 'store_1',
        status: 'open'
      }
    ])
    .select()

  console.log('INSERT:', insertData, insertError)

  const { data: readData, error: readError } = await supabase
    .from('reports')
    .select('*')

  console.log('READ:', readData, readError)
}

test()