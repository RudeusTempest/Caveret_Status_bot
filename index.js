import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://xunyaxrufifqtcmpjnhw.supabase.co',
  'sb_publishable_tGMUVt2M-Zxgr_I30vWVOA_RZyjqdBk'
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