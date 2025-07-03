import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://amrgspjjmpzbicecgooi.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtcmdzcGpqbXB6YmljZWNnb29pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE1MDc5MzksImV4cCI6MjA2NzA4MzkzOX0.IAPUuzQUK9s5e4EuAdN23mM0KkiYeAbGYSBfCp-uON0'
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
